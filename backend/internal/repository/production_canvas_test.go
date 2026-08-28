package repository

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestExistingProductionCanvasRetryRechecksCurrentSourceHash(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:production-canvas-retry-hash?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.Project{}, &model.ProjectUnit{}, &model.CanvasProject{}, &model.CanvasUnitLink{}, &model.ProductionCanvasGuard{}, &model.AdminAuditEvent{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	oldDigest := sha256.Sum256([]byte("v1"))
	oldHash := hex.EncodeToString(oldDigest[:])
	items := []any{
		&model.Project{ID: "project-retry", UserID: "user-retry", Name: "retry", Revision: 8},
		&model.ProjectUnit{ID: "unit-retry", ProjectID: "project-retry", Title: "unit", SourceText: "v2"},
		&model.CanvasProject{ID: "canvas-retry", UserID: "user-retry", ProjectID: "project-retry", Title: "canvas", PayloadJSON: `{}`, CreatedAt: now, UpdatedAt: now},
		&model.CanvasUnitLink{ID: "link-retry", ProjectID: "project-retry", CanvasID: "canvas-retry", UnitID: "unit-retry", Role: "production", CreatedAt: now},
		&model.AdminAuditEvent{ID: "audit-retry", ActorUserID: "user-retry", Action: "production_canvas.acquire", TargetType: "production_canvas", TargetID: "canvas-retry", CreatedAt: now},
		&model.ProductionCanvasGuard{ID: "guard-retry", ProjectID: "project-retry", UnitID: "unit-retry", CanvasID: "canvas-retry", LinkID: "link-retry", ConfirmationID: "confirm-retry", ConfirmedByUserID: "user-retry", ObservedSourceHash: oldHash, AuditEventID: "audit-retry", CreatedAt: now},
	}
	for _, item := range items {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	repo := New(db)
	_, err = repo.existingProductionCanvas(ProductionCanvasAcquireInput{UserID: "user-retry", ProjectID: "project-retry", UnitID: "unit-retry", ExpectedContentHash: oldHash})
	if !errors.Is(err, ErrProductionCanvasContentHashConflict) {
		t.Fatalf("retry fallback error = %v, want source hash conflict", err)
	}
}
