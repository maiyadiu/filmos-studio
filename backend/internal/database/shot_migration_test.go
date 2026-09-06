package database

import (
	"path/filepath"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func TestShotMigrationPreservesExistingRows(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "legacy.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	t.Cleanup(func() { _ = conn.Close() })
	for _, statement := range []string{
		`CREATE TABLE project_units (id text PRIMARY KEY, project_id text, title text, source_text text, revision integer NOT NULL DEFAULT 1, status text)`,
		`CREATE TABLE shots (id text PRIMARY KEY, project_id text, unit_id text, title text, description text, position integer, duration_ms integer, status text)`,
		`INSERT INTO project_units VALUES ('u', 'p', '原章', '<p>原稿**不改**</p>', 3, 'draft')`,
		`INSERT INTO shots VALUES ('s', 'p', 'u', '原镜', '原描述', 7, 5000, 'ready')`,
	} {
		if err := db.Exec(statement).Error; err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := db.AutoMigrate(Models()...); err != nil {
			t.Fatal(err)
		}
	}
	var unit model.ProjectUnit
	var shot model.Shot
	if err := db.First(&unit, "id = ?", "u").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&shot, "id = ?", "s").Error; err != nil {
		t.Fatal(err)
	}
	if unit.Revision != 3 || unit.ShotRevision != 0 || unit.SourceText != "<p>原稿**不改**</p>" || unit.Title != "原章" {
		t.Fatalf("source changed during migration: %+v", unit)
	}
	if shot.Revision != 1 || shot.SourceRevision != 0 || shot.SourceHash != "" || shot.Title != "原镜" || shot.Description != "原描述" || shot.Position != 7 || shot.DurationMs != 5000 || shot.Status != "ready" || shot.ProjectID != "p" || shot.UnitID != "u" || shot.Content.Camera != "" {
		t.Fatalf("shot changed or fake binding added: %+v", shot)
	}
	for _, table := range []any{&model.ShotRevision{}, &model.ShotBatchReceipt{}} {
		var count int64
		if err := db.Model(table).Count(&count).Error; err != nil || count != 0 {
			t.Fatal("migration fabricated historical writes")
		}
	}
}
