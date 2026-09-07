package handler

import (
	"context"
	"errors"
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
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/service"
)

func TestProjectDirectoryHTTPRejectsForeignOriginAndSpoofedHost(t *testing.T) {
	t.Setenv("CANVAS_CORS_ORIGINS", "http://127.0.0.1:57881")
	data := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(data, "fixture.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	t.Cleanup(func() { conn.Close() })
	s := service.NewWithRuntimeCapabilities(repository.New(db), data, service.RuntimeCapabilitiesForDeployment("127.0.0.1:54410", "false", "true"))
	for _, test := range []struct {
		origin, host, remote, header string
		allowed                      bool
	}{
		{"http://127.0.0.1:57881", "127.0.0.1:54410", "127.0.0.1:50000", "1", true},
		{"http://evil.example", "127.0.0.1:54410", "127.0.0.1:50000", "1", false},
		{"http://127.0.0.1:9999", "127.0.0.1:54410", "127.0.0.1:50000", "1", false},
		{"http://127.0.0.1:57881", "evil.example:54410", "127.0.0.1:50000", "1", false},
		{"http://127.0.0.1:57881", "127.0.0.1:54410", "10.0.0.2:50000", "1", false},
		{"http://127.0.0.1:57881", "127.0.0.1:54410", "127.0.0.1:50000", "", false},
	} {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("POST", "http://"+test.host+"/api/project-locations/choose", strings.NewReader("{}"))
		c.Request.RemoteAddr = test.remote
		c.Request.Header.Set("Origin", test.origin)
		c.Request.Header.Set("X-FilmOS-Project-Directory", test.header)
		c.Request.Header.Set("Content-Type", "application/json")
		if got := projectDirectoryLocalRequest(c, s); got != test.allowed {
			t.Fatalf("origin=%s host=%s got %v", test.origin, test.host, got)
		}
	}
}

type directoryBrowserPlatform struct {
	service.ProjectDirectoryPlatform
	root, downloads string
}

func (p directoryBrowserPlatform) Downloads(context.Context) (string, error) { return p.downloads, nil }
func (p directoryBrowserPlatform) Choose(ctx context.Context, existing bool) (string, error) {
	path, err := p.ProjectDirectoryPlatform.Choose(ctx, existing)
	if err != nil || path == "" {
		return path, err
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	if path != p.root && !strings.HasPrefix(path, p.root+string(os.PathSeparator)) {
		return "", errors.New("隔离验收只允许选择本次临时目录")
	}
	return path, nil
}

func TestProjectDirectoryBrowserFixture(t *testing.T) {
	if os.Getenv("FILMOS_DIRECTORY_BROWSER_FIXTURE") != "1" {
		t.Skip("opt-in temporary project UI; no real user data")
	}
	root := t.TempDir()
	root, _ = filepath.EvalSymlinks(root)
	data := filepath.Join(root, "runtime")
	downloads := filepath.Join(root, "下载")
	custom := filepath.Join(root, "自选位置")
	for _, dir := range []string{data, downloads, custom} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	db, err := gorm.Open(sqlite.Open(filepath.Join(data, "fixture.db")+"?_busy_timeout=5000&_journal_mode=WAL"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(database.Models()...); err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	t.Cleanup(func() { conn.Close() })
	native, err := service.NativeProjectDirectoryPlatform()
	if err != nil {
		t.Fatal(err)
	}
	svc := service.NewWithRuntimeCapabilities(repository.New(db), data, service.RuntimeCapabilitiesForDeployment("127.0.0.1:54410", "false", "true"))
	svc.SetProjectDirectoryPlatform(directoryBrowserPlatform{native, root, downloads})
	previous := runtimeService
	ConfigureRuntime(svc)
	t.Cleanup(func() { ConfigureRuntime(previous) })
	t.Setenv("CANVAS_CORS_ORIGINS", "http://127.0.0.1:57881")
	router := gin.New()
	api := router.Group("/api")
	RegisterAuthRoutes(api, svc)
	RegisterFeatureAvailabilityRoutes(api, svc)
	RegisterLogicalModelRoutes(api, svc)
	RegisterModelCatalogRoutes(api, svc)
	RegisterUserDataRoutes(api, svc)
	RegisterSkillRoutes(api, svc)
	RegisterAnnouncementRoutes(api, svc)
	RegisterFinanceRoutes(api, svc)
	RegisterTaskRoutes(api, svc)
	RegisterProjectRoutes(api, svc)
	listener, err := net.Listen("tcp", "127.0.0.1:54410")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && (strings.HasPrefix(r.URL.Path, "/api/tasks") || strings.HasPrefix(r.URL.Path, "/api/ai") || strings.HasPrefix(r.URL.Path, "/api/resources")) {
			w.WriteHeader(403)
			return
		}
		router.ServeHTTP(w, r)
	})}
	t.Cleanup(func() { server.Close() })
	go server.Serve(listener)
	t.Logf("DIRECTORY_UI_FIXTURE root=%s custom=%s default=%s port=54410 temporary=true generation=disabled", root, custom, downloads)
	<-time.After(25 * time.Minute)
}
