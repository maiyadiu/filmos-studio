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

func authSessionFixture(t *testing.T, bind, flag string) (*gin.Engine, *gorm.DB) {
	t.Helper()
	dir := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "auth.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(database.Models()...); err != nil {
		t.Fatal(err)
	}
	conn, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	svc := service.NewWithRuntimeCapabilities(repository.New(db), dir, service.RuntimeCapabilitiesForDeployment(bind, "false", flag))
	router := gin.New()
	api := router.Group("/api")
	RegisterAuthRoutes(api, svc)
	if t.Name() == "TestAuthSessionBrowserFixture" {
		previous := runtimeService
		ConfigureRuntime(svc)
		t.Cleanup(func() { ConfigureRuntime(previous) })
		RegisterFeatureAvailabilityRoutes(api, svc)
		RegisterLogicalModelRoutes(api, svc)
		RegisterModelCatalogRoutes(api, svc)
		RegisterUserDataRoutes(api, svc)
		RegisterSkillRoutes(api, svc)
		RegisterAnnouncementRoutes(api, svc)
		RegisterFinanceRoutes(api, svc)
		RegisterTaskRoutes(api, svc)
		RegisterProjectRoutes(api, svc)
	}
	return router, db
}

func TestAuthSessionBrowserFixture(t *testing.T) {
	mode := os.Getenv("FILMOS_AUTH_BROWSER_FIXTURE")
	if mode != "local" && mode != "account" {
		t.Skip("opt-in isolated auth UI only")
	}
	flag := "false"
	if mode == "local" {
		flag = "true"
	}
	router, _ := authSessionFixture(t, "127.0.0.1:54409", flag)
	listener, err := net.Listen("tcp", "127.0.0.1:54409")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		router.ServeHTTP(w, r)
	}), ReadHeaderTimeout: 5 * time.Second}
	t.Cleanup(func() { _ = server.Close() })
	go func() { _ = server.Serve(listener) }()
	t.Logf("AUTH_UI_FIXTURE mode=%s addr=127.0.0.1:54409 temporary=true writes=disabled", mode)
	<-time.After(15 * time.Minute)
}

func authSessionGet(router *gin.Engine, route, cookie string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, route, nil)
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: cookie})
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	return w
}

func TestAuthSessionDesktopStartsAsStableAdminWithoutCookie(t *testing.T) {
	router, _ := authSessionFixture(t, "127.0.0.1:43101", "true")
	var previous string
	for _, cookie := range []string{"", "expired-or-malformed"} {
		w := authSessionGet(router, "/api/auth/session", cookie)
		var body struct {
			Code int
			Data struct {
				AuthMode string
				User     model.User
			}
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || body.Code != 0 || body.Data.AuthMode != "desktop_local" || body.Data.User.Role != model.UserRoleAdmin || body.Data.User.ID == "" || body.Data.User.PasswordHash != "" {
			t.Fatalf("local session status=%d body=%s", w.Code, w.Body.String())
		}
		if previous != "" && body.Data.User.ID != previous {
			t.Fatal("local identity changed")
		}
		previous = body.Data.User.ID
	}
	if w := authSessionGet(router, "/api/channels/system", ""); w.Code != 200 {
		t.Fatalf("admin route status=%d", w.Code)
	}
	settings := authSessionGet(router, "/api/auth/settings", "")
	if !strings.Contains(settings.Body.String(), `"authMode":"desktop_local"`) || !strings.Contains(settings.Body.String(), `"registrationEnabled":false`) {
		t.Fatal(settings.Body.String())
	}
}

func TestAuthSessionAccountLoginIsPreserved(t *testing.T) {
	for _, config := range []struct{ bind, flag string }{{"127.0.0.1:43101", "false"}, {"0.0.0.0:43101", "true"}, {":43101", "true"}} {
		t.Run(config.bind+config.flag, func(t *testing.T) {
			router, _ := authSessionFixture(t, config.bind, config.flag)
			w := authSessionGet(router, "/api/auth/session", "")
			if w.Code != 200 || !strings.Contains(w.Body.String(), `"user":null`) || !strings.Contains(w.Body.String(), `"authMode":"account"`) {
				t.Fatal(w.Body.String())
			}
			if w := authSessionGet(router, "/api/channels/system", ""); w.Code != 401 {
				t.Fatalf("anonymous admin route status=%d", w.Code)
			}
		})
	}
}

func TestAuthSessionDatabaseFailureIsNotAnonymousSuccess(t *testing.T) {
	for _, flag := range []string{"true", "false"} {
		t.Run(flag, func(t *testing.T) {
			router, db := authSessionFixture(t, "127.0.0.1:43101", flag)
			conn, _ := db.DB()
			if err := conn.Close(); err != nil {
				t.Fatal(err)
			}
			w := authSessionGet(router, "/api/auth/session", "session.token")
			if w.Code != 500 || strings.Contains(w.Body.String(), `"user":null`) || strings.Contains(w.Body.String(), "database") {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestAuthSessionDisabledAccountIsNotAnonymousSuccess(t *testing.T) {
	router, db := authSessionFixture(t, "127.0.0.1:43101", "false")
	hash := sha256.Sum256([]byte("test-token"))
	for _, value := range []any{
		&model.User{ID: "disabled", Username: "disabled", Status: model.UserStatusDisabled},
		&model.AuthSession{ID: "session", UserID: "disabled", TokenHash: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)},
	} {
		if err := db.Create(value).Error; err != nil {
			t.Fatal(err)
		}
	}
	w := authSessionGet(router, "/api/auth/session", "session.test-token")
	if w.Code != 403 || strings.Contains(w.Body.String(), `"user":null`) {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}
