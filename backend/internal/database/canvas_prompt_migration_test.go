package database

import (
	"path/filepath"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func TestCanvasPromptMigrationPreservesLegacyCanvas(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "old-canvas.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	t.Cleanup(func() { _ = conn.Close() })
	raw := `{"id":"c","nodes":[{"id":"s","type":"script","metadata":{"storyboard":{"rows":[{"id":"r","imageGenerationPrompt":"# 旧稿\n一字不改","videoMotionPrompt":"视频原文"}]}}}]}`
	if err := db.Exec(`CREATE TABLE canvas_projects (id text PRIMARY KEY,user_id text,title text,payload_json text)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO canvas_projects (id,user_id,title,payload_json) VALUES (?,?,?,?)`, "c", "u", "旧画布", raw).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := db.AutoMigrate(Models()...); err != nil {
			t.Fatal(err)
		}
	}
	var canvas model.CanvasProject
	if err := db.First(&canvas, "id = ?", "c").Error; err != nil {
		t.Fatal(err)
	}
	if canvas.UserID != "u" || canvas.Title != "旧画布" || canvas.PayloadJSON != raw {
		t.Fatal("migration rewrote legacy canvas")
	}
	for _, row := range []any{&model.CanvasPromptRevision{}, &model.CanvasPromptReceipt{}} {
		var count int64
		if err := db.Model(row).Count(&count).Error; err != nil || count != 0 {
			t.Fatal("migration fabricated prompt history")
		}
	}
}
