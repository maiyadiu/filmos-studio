package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/service"
)

func scriptHTTPFixture(t *testing.T) *gin.Engine {
	t.Helper()
	t.Setenv("CANVAS_DESKTOP_LOCAL_AUTH_ENABLED", "false")
	dir := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "script.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	t.Cleanup(func() { _ = conn.Close() })
	if err := db.AutoMigrate(&model.User{}, &model.AuthSession{}, &model.Project{}, &model.ProjectUnit{}, &model.ProjectUnitRevision{}); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("script-test-token"))
	for _, row := range []any{
		&model.User{ID: "owner", Username: "script-fixture", Status: model.UserStatusActive},
		&model.AuthSession{ID: "script-session", UserID: "owner", TokenHash: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)},
		&model.Project{ID: "project", UserID: "owner", Name: "剧本修订隔离样例", Status: model.ProjectStatusActive, Revision: 1},
		&model.Project{ID: "foreign", UserID: "other", Name: "不可访问", Status: model.ProjectStatusActive, Revision: 1},
		&model.ProjectUnit{ID: "unit", ProjectID: "project", Title: "第一场：客厅", Kind: model.ProjectUnitKindChapter, SourceText: "<p>场景：客厅</p><p>林夏：我不走。</p><p>动作：门关上。</p>", Status: model.ProjectUnitStatusDraft, Revision: 1, CreatedAt: time.Now(), UpdatedAt: time.Now()},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	router := gin.New()
	RegisterProjectRoutes(router.Group("/api"), service.New(repository.New(db), dir))
	return router
}

func TestProjectScriptHTTPAuthConflictAndReadback(t *testing.T) {
	router := scriptHTTPFixture(t)
	call := func(method, path, body string, auth bool) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		if auth {
			request.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "script-session.script-test-token"})
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}
	path := "/api/projects/project/units/unit/script-revisions"
	if got := call("GET", path+"/1", "", false); got.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated read: %d", got.Code)
	}
	if got := call("GET", "/api/projects/foreign/units/unit/script-revisions/1", "", true); got.Code != http.StatusNotFound {
		t.Fatalf("foreign project: %d", got.Code)
	}
	body := `{"expectedRevision":1,"requestId":"one","sourceText":"<p>场景：客厅</p><p>林夏：我陪你。</p><p>动作：门关上。</p>","note":"只修改对白"}`
	for i := 0; i < 2; i++ {
		response := call("POST", path, body, true)
		if response.Code != 200 {
			t.Fatalf("save/retry: %s", response.Body.String())
		}
		var result struct {
			Code int
			Data repository.ScriptRevisionResult
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.Code != 0 || result.Data.Unit.Revision != 2 || result.Data.Replayed != (i == 1) {
			t.Fatalf("incorrect receipt: %+v", result)
		}
	}
	for _, test := range []struct {
		body   string
		status int
	}{
		{strings.Replace(body, `"one"`, `"two"`, 1), 409},
		{strings.Replace(body, "我陪你。", "我先走。", 1), 409},
		{`{"sourceText":"bad"}`, 400},
	} {
		result := call("POST", path, test.body, true)
		if result.Code != test.status {
			t.Fatalf("write boundary: %d %s", result.Code, result.Body.String())
		}
		var envelope struct{ Code int }
		_ = json.Unmarshal(result.Body.Bytes(), &envelope)
		if envelope.Code == 0 {
			t.Fatal("business error reported as success")
		}
	}
	if got := call("GET", path+"/1", "", true); !strings.Contains(got.Body.String(), "我不走") {
		t.Fatal("original was not preserved")
	}
	if got := call("GET", path+"/2", "", true); !strings.Contains(got.Body.String(), "我陪你") {
		t.Fatal("saved version not readable")
	}
}

// Explicit, loopback-only fixture for browser and real tool transport checks.
// Never loads application data, provider credentials, or a user project.
func TestProjectScriptBrowserFixture(t *testing.T) {
	if os.Getenv("FILMOS_SCRIPT_BROWSER_FIXTURE") != "1" {
		t.Skip("opt-in isolated browser fixture")
	}
	router := scriptHTTPFixture(t)
	router.GET("/api/script-fixture-session", func(c *gin.Context) {
		c.SetCookie(service.SessionCookieName, "script-session.script-test-token", 600, "/", "", false, true)
		c.JSON(200, gin.H{"fixture": true})
	})
	server := httptest.NewServer(router)
	defer server.Close()
	t.Logf("SCRIPT_FIXTURE_URL=%s", server.URL)
	<-time.After(8 * time.Minute)
}
