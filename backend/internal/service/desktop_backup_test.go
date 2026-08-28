package service

import (
	"archive/zip"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestDesktopBackupCreatesVerifiableRestorablePackage(t *testing.T) {
	dataDir := t.TempDir()
	db, err := database.Open(database.Config{DataDir: dataDir})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	user := model.User{ID: desktopLocalUserID, Username: "filmos-desktop-local", DisplayName: "FilmOS 本地工作台", Role: "admin", Status: "active", CreatedAt: now, UpdatedAt: now}
	project := model.CanvasProject{ID: "backup-canvas-1", UserID: user.ID, Title: "备份黄金用例", PayloadJSON: `{"id":"backup-canvas-1","title":"备份黄金用例","nodes":[]}`, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&project).Error; err != nil {
		t.Fatal(err)
	}
	resourcePath := filepath.Join(dataDir, "resources", "users", user.ID, "image", "sample.bin")
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourcePath, []byte("FilmOS backup resource"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, ".settings-key"), []byte("must-not-be-exported"), 0o600); err != nil {
		t.Fatal(err)
	}

	svc := NewWithRuntimeCapabilities(repository.New(db), dataDir, RuntimeCapabilities{desktopLocalAuth: true})
	artifact, err := svc.CreateDesktopBackup(user.ID, "0.7.0-test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(artifact.Path)
	manifest, err := VerifyDesktopBackupPackage(artifact.Path)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.ApplicationVersion != "0.7.0-test" || manifest.UserID != user.ID || len(manifest.Entries) != 2 {
		t.Fatalf("unexpected manifest: %#v", manifest)
	}

	restoredDatabase := filepath.Join(t.TempDir(), "open_ai_canvas.db")
	if err := extractBackupTestFile(artifact.Path, manifest.Database, restoredDatabase); err != nil {
		t.Fatal(err)
	}
	restored, err := database.Open(database.Config{DSN: restoredDatabase + "?_foreign_keys=on"})
	if err != nil {
		t.Fatal(err)
	}
	var restoredProject model.CanvasProject
	if err := restored.First(&restoredProject, "id = ? AND user_id = ?", project.ID, user.ID).Error; err != nil {
		t.Fatal(err)
	}
	if restoredProject.Title != project.Title {
		t.Fatalf("restored project mismatch: %#v", restoredProject)
	}

	reader, err := zip.OpenReader(artifact.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	for _, file := range reader.File {
		if file.Name == ".settings-key" || file.Name == "settings-key" {
			t.Fatal("credential encryption key must not be exported")
		}
	}
}

func TestDesktopBackupRejectsPublicRuntime(t *testing.T) {
	svc := &Service{runtimeCapabilities: RuntimeCapabilities{}}
	_, err := svc.CreateDesktopBackup("user-1", "")
	if err == nil {
		t.Fatal("expected public runtime backup rejection")
	}
	if authErr, ok := err.(*AuthError); !ok || authErr.Status != http.StatusForbidden {
		t.Fatalf("expected forbidden auth error, got %T %#v", err, err)
	}
}

func extractBackupTestFile(packagePath, entryName, outputPath string) error {
	reader, err := zip.OpenReader(packagePath)
	if err != nil {
		return err
	}
	defer reader.Close()
	for _, file := range reader.File {
		if file.Name != entryName {
			continue
		}
		input, err := file.Open()
		if err != nil {
			return err
		}
		defer input.Close()
		output, err := os.OpenFile(outputPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(output, input)
		closeErr := output.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	}
	return os.ErrNotExist
}
