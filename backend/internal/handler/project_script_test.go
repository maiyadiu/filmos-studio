package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/service"
)

func scriptHTTPFixture(t *testing.T) *gin.Engine {
	t.Helper()
	t.Setenv("CANVAS_DESKTOP_LOCAL_AUTH_ENABLED", "false")
	dir := t.TempDir()
	resuming := false
	// Keep opt-in browser evidence after its server expires. Ordinary unit tests
	// still clean up their temporary database; never open an application data root.
	if t.Name() == "TestProjectScriptBrowserFixture" && os.Getenv("FILMOS_SCRIPT_BROWSER_FIXTURE") == "1" {
		root, err := filepath.Abs("../../../.local/创作验收")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(root, 0700); err != nil {
			t.Fatal(err)
		}
		if resume := os.Getenv("FILMOS_SCRIPT_FIXTURE_RESUME_DIR"); resume != "" {
			dir, err = filepath.Abs(resume)
			if err != nil {
				t.Fatal(err)
			}
			realDir, realErr := filepath.EvalSymlinks(dir)
			_, numberErr := strconv.ParseUint(strings.TrimPrefix(filepath.Base(dir), "db-"), 10, 64)
			if realErr != nil || realDir != dir || filepath.Dir(dir) != root || !strings.HasPrefix(filepath.Base(dir), "db-") || numberErr != nil {
				t.Fatal("owned non-symlink fixture directory required")
			}
			if info, err := os.Stat(filepath.Join(dir, "script.db")); err != nil || !info.Mode().IsRegular() {
				t.Fatal("existing fixture database required")
			}
			resuming = true
		} else {
			dir, err = os.MkdirTemp(root, "db-")
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "script.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	t.Cleanup(func() { _ = conn.Close() })
	hash := sha256.Sum256([]byte("script-test-token"))
	if resuming {
		var user model.User
		var project model.Project
		var auth model.AuthSession
		if db.First(&user, "id = ?", "owner").Error != nil || user.Username != "script-fixture" || db.First(&project, "id = ?", "project").Error != nil || project.UserID != "owner" || project.Name != "剧本修订隔离样例" || db.First(&auth, "id = ?", "script-session").Error != nil || auth.UserID != "owner" || auth.TokenHash != hex.EncodeToString(hash[:]) {
			t.Fatal("fixture identity mismatch; no writes permitted")
		}
		if err := db.Model(&auth).Update("expires_at", time.Now().Add(time.Hour)).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.AutoMigrate(database.Models()...); err != nil {
		t.Fatal(err)
	}
	if !resuming {
		for _, row := range []any{
			&model.User{ID: "owner", Username: "script-fixture", Status: model.UserStatusActive},
			&model.AuthSession{ID: "script-session", UserID: "owner", TokenHash: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)},
			&model.Project{ID: "project", UserID: "owner", Name: "剧本修订隔离样例", Status: model.ProjectStatusActive, Revision: 1},
			&model.Project{ID: "foreign", UserID: "other", Name: "不可访问", Status: model.ProjectStatusActive, Revision: 1},
			&model.Project{ID: "other-project", UserID: "owner", Name: "另一个隔离项目", Status: model.ProjectStatusActive, Revision: 1},
			&model.ProjectUnit{ID: "other-unit", ProjectID: "other-project", Title: "第一场：客厅", Kind: model.ProjectUnitKindChapter, SourceText: "<p>同名章节，不得修改。</p>", Status: model.ProjectUnitStatusDraft, Revision: 1},
			&model.ProjectUnit{ID: "unit", ProjectID: "project", Title: "第一场：客厅", Kind: model.ProjectUnitKindChapter, SourceText: "<p>场景：客厅</p><p>林夏：我不走。</p><p>动作：门关上。</p>", Status: model.ProjectUnitStatusDraft, Revision: 1, CreatedAt: time.Now(), UpdatedAt: time.Now()},
		} {
			if err := db.Create(row).Error; err != nil {
				t.Fatal(err)
			}
		}
	}
	router := gin.New()
	svc := service.New(repository.New(db), dir)
	workbenchFixture := (t.Name() == "TestProjectScriptBrowserFixture" && os.Getenv("FILMOS_SCRIPT_BROWSER_FIXTURE") == "1") || t.Name() == "TestProjectScriptWorkbenchRoutes"
	if workbenchFixture || strings.HasPrefix(t.Name(), "TestCanvasPromptHTTP") || strings.HasPrefix(t.Name(), "TestCanvasContentHTTP") {
		previousRuntime := runtimeService
		ConfigureRuntime(svc)
		t.Cleanup(func() { ConfigureRuntime(previousRuntime) })
	}
	api := router.Group("/api")
	projectAPI := api.Group("")
	if workbenchFixture {
		// Exercise the actual Router/AppProviders auth and feature gates. No
		// worker, relay, generation, upload or production data is configured.
		RegisterAuthRoutes(api, svc)
		RegisterFeatureAvailabilityRoutes(api, svc)
		RegisterLogicalModelRoutes(api, svc)
		RegisterModelCatalogRoutes(api, svc)
		RegisterSkillRoutes(api, svc)
		RegisterAnnouncementRoutes(api, svc)
		readAPI := api.Group("")
		readAPI.Use(func(c *gin.Context) {
			if c.Request.Method != http.MethodGet {
				c.AbortWithStatus(http.StatusNotFound)
				return
			}
			c.Next()
		})
		RegisterFinanceRoutes(readAPI, svc)
		RegisterTaskRoutes(readAPI, svc)
		projectAPI.Use(RequireFeature(svc, service.FeatureShortDrama))
	}
	RegisterProjectRoutes(projectAPI, svc)
	RegisterUserDataRoutes(api, svc)
	t.Logf("SCRIPT_FIXTURE_DATA_DIR=%s", dir)
	return router
}

func TestProjectScriptWorkbenchRoutes(t *testing.T) {
	router := scriptHTTPFixture(t)
	for _, path := range []string{"/api/auth/session", "/api/features", "/api/skills/added", "/api/projects/project", "/api/wallet", "/api/tasks?limit=5&activeOnly=true"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "script-session.script-test-token"})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		var body struct {
			Code int             `json:"code"`
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != http.StatusOK || body.Code != 0 {
			t.Fatalf("native workbench route %s: %d %s", path, response.Code, response.Body.String())
		}
		if path == "/api/auth/session" && (!strings.Contains(string(body.Data), `"id":"owner"`) || !strings.Contains(string(body.Data), `"shortDramaEnabled":true`)) {
			t.Fatal("real fixture session and feature hydration required")
		}
	}
	for _, path := range []string{"/api/projects/project", "/api/features"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("native auth gate %s: %d", path, response.Code)
		}
	}
	for _, path := range []string{"/api/tasks", "/api/wallet/redeem"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`)))
		if response.Code != http.StatusNotFound {
			t.Fatal("fixture must not expose generation or financial writes")
		}
	}
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
		c.SetCookie(service.SessionCookieName, "script-session.script-test-token", 1800, "/", "", false, true)
		c.JSON(200, gin.H{"fixture": true})
	})
	server := httptest.NewUnstartedServer(router)
	if value := os.Getenv("FILMOS_SCRIPT_FIXTURE_PORT"); value != "" {
		port, err := strconv.Atoi(value)
		if err != nil || port < 49152 || port > 65535 {
			t.Fatal("isolated fixture port must be 49152–65535")
		}
		listener, err := net.Listen("tcp", "127.0.0.1:"+value)
		if err != nil {
			t.Fatal(err)
		}
		_ = server.Listener.Close()
		server.Listener = listener
	}
	server.Start()
	defer server.Close()
	t.Logf("SCRIPT_FIXTURE_URL=%s", server.URL)
	<-time.After(30 * time.Minute)
}
