package repository

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrProductionCanvasConflict = errors.New("production canvas conflict")

var ErrProductionCanvasRevisionConflict = errors.New("production canvas project revision conflict")

var ErrProductionCanvasContentHashConflict = errors.New("production canvas unit content hash conflict")

type ProductionCanvasConflictError struct {
	CanvasIDs []string
}

func (e *ProductionCanvasConflictError) Error() string {
	return fmt.Sprintf("production canvas conflict: %s", strings.Join(e.CanvasIDs, ","))
}

func (e *ProductionCanvasConflictError) Unwrap() error {
	return ErrProductionCanvasConflict
}

type ProductionCanvasAcquireInput struct {
	UserID              string
	ProjectID           string
	UnitID              string
	ExpectedRevision    int64
	ExpectedContentHash string
	Canvas              model.CanvasProject
	Link                model.CanvasUnitLink
	Guard               model.ProductionCanvasGuard
	AuditEvent          model.AdminAuditEvent
}

type ProductionCanvasAcquireResult struct {
	Canvas          model.CanvasProject
	Link            model.CanvasUnitLink
	Guard           model.ProductionCanvasGuard
	AuditEvent      model.AdminAuditEvent
	ProjectRevision int64
	Created         bool
}

// AcquireProductionCanvas serializes the empty-link decision on the Host Project
// row. The generic canvas-link write path rejects role=production, so this is the
// only application path that can create the default production association.
func (r *Repository) AcquireProductionCanvas(input ProductionCanvasAcquireInput) (ProductionCanvasAcquireResult, error) {
	for attempt := 0; attempt < 8; attempt++ {
		result, err := r.acquireProductionCanvasOnce(input)
		if err == nil || errors.Is(err, ErrProductionCanvasConflict) || errors.Is(err, ErrProductionCanvasRevisionConflict) || errors.Is(err, ErrProductionCanvasContentHashConflict) || errors.Is(err, gorm.ErrRecordNotFound) {
			return result, err
		}
		if !isProductionCanvasConcurrentWriteError(err) {
			return ProductionCanvasAcquireResult{}, err
		}
		if existing, foundErr := r.existingProductionCanvas(input); foundErr == nil {
			return existing, nil
		} else if errors.Is(foundErr, ErrProductionCanvasConflict) || errors.Is(foundErr, ErrProductionCanvasContentHashConflict) {
			return ProductionCanvasAcquireResult{}, foundErr
		}
		time.Sleep(time.Duration(attempt+1) * 5 * time.Millisecond)
	}
	if existing, err := r.existingProductionCanvas(input); err == nil || errors.Is(err, ErrProductionCanvasConflict) || errors.Is(err, ErrProductionCanvasContentHashConflict) {
		return existing, err
	}
	return ProductionCanvasAcquireResult{}, ErrProductionCanvasConflict
}

func (r *Repository) acquireProductionCanvasOnce(input ProductionCanvasAcquireInput) (ProductionCanvasAcquireResult, error) {
	result := ProductionCanvasAcquireResult{}
	operation := func(tx *gorm.DB) error {
		tx = tx.Session(&gorm.Session{NewDB: true, SkipDefaultTransaction: true})
		var project model.Project
		if err := tx.Session(&gorm.Session{NewDB: true}).Clauses(clause.Locking{Strength: "UPDATE"}).First(&project, "id = ? AND user_id = ?", input.ProjectID, input.UserID).Error; err != nil {
			return err
		}
		var unit model.ProjectUnit
		if err := tx.Session(&gorm.Session{NewDB: true}).First(&unit, "id = ? AND project_id = ?", input.UnitID, input.ProjectID).Error; err != nil {
			return err
		}
		digest := sha256.Sum256([]byte(unit.SourceText))
		if hex.EncodeToString(digest[:]) != input.ExpectedContentHash {
			return ErrProductionCanvasContentHashConflict
		}

		var links []model.CanvasUnitLink
		if err := tx.Session(&gorm.Session{NewDB: true}).Where("project_id = ? AND unit_id = ? AND role = ?", input.ProjectID, input.UnitID, "production").Order("created_at asc, id asc").Find(&links).Error; err != nil {
			return err
		}
		if len(links) > 1 {
			return productionCanvasLinksConflict(links)
		}
		if len(links) == 1 {
			var canvas model.CanvasProject
			if err := tx.Session(&gorm.Session{NewDB: true}).First(&canvas, "id = ? AND user_id = ? AND project_id = ?", links[0].CanvasID, input.UserID, input.ProjectID).Error; err != nil {
				return ErrProductionCanvasConflict
			}
			guard, audit, err := productionCanvasReceipt(tx, input.ProjectID, input.UnitID, links[0])
			if err != nil {
				return err
			}
			result = ProductionCanvasAcquireResult{Canvas: canvas, Link: links[0], Guard: guard, AuditEvent: audit, ProjectRevision: project.Revision, Created: false}
			return nil
		}

		if project.Revision != input.ExpectedRevision {
			return ErrProductionCanvasRevisionConflict
		}
		if err := tx.Session(&gorm.Session{NewDB: true}).Create(&input.Guard).Error; err != nil {
			return err
		}
		if err := tx.Session(&gorm.Session{NewDB: true}).Create(&input.Canvas).Error; err != nil {
			return err
		}
		if err := tx.Session(&gorm.Session{NewDB: true}).Create(&input.Link).Error; err != nil {
			return err
		}
		if err := tx.Session(&gorm.Session{NewDB: true}).Create(&input.AuditEvent).Error; err != nil {
			return err
		}
		now := time.Now()
		updated := tx.Session(&gorm.Session{NewDB: true}).Model(&model.Project{}).
			Where("id = ? AND user_id = ? AND revision = ?", input.ProjectID, input.UserID, input.ExpectedRevision).
			Updates(map[string]any{"revision": gorm.Expr("revision + 1"), "updated_at": now})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return ErrProductionCanvasRevisionConflict
		}
		result = ProductionCanvasAcquireResult{Canvas: input.Canvas, Link: input.Link, Guard: input.Guard, AuditEvent: input.AuditEvent, ProjectRevision: input.ExpectedRevision + 1, Created: true}
		return nil
	}
	var err error
	if r.Dialect() == "sqlite" {
		err = r.db.Connection(func(connection *gorm.DB) error {
			if beginErr := connection.Session(&gorm.Session{NewDB: true}).Exec("BEGIN IMMEDIATE").Error; beginErr != nil {
				return beginErr
			}
			if operationErr := operation(connection); operationErr != nil {
				_ = connection.Session(&gorm.Session{NewDB: true}).Exec("ROLLBACK").Error
				return operationErr
			}
			if commitErr := connection.Session(&gorm.Session{NewDB: true}).Exec("COMMIT").Error; commitErr != nil {
				_ = connection.Session(&gorm.Session{NewDB: true}).Exec("ROLLBACK").Error
				return commitErr
			}
			return nil
		})
	} else {
		err = r.db.Transaction(operation)
	}
	return result, err
}

func (r *Repository) existingProductionCanvas(input ProductionCanvasAcquireInput) (ProductionCanvasAcquireResult, error) {
	var project model.Project
	if err := r.db.First(&project, "id = ? AND user_id = ?", input.ProjectID, input.UserID).Error; err != nil {
		return ProductionCanvasAcquireResult{}, err
	}
	var unit model.ProjectUnit
	if err := r.db.First(&unit, "id = ? AND project_id = ?", input.UnitID, input.ProjectID).Error; err != nil {
		return ProductionCanvasAcquireResult{}, err
	}
	digest := sha256.Sum256([]byte(unit.SourceText))
	if hex.EncodeToString(digest[:]) != input.ExpectedContentHash {
		return ProductionCanvasAcquireResult{}, ErrProductionCanvasContentHashConflict
	}
	var links []model.CanvasUnitLink
	if err := r.db.Where("project_id = ? AND unit_id = ? AND role = ?", input.ProjectID, input.UnitID, "production").Order("created_at asc, id asc").Find(&links).Error; err != nil {
		return ProductionCanvasAcquireResult{}, err
	}
	if len(links) != 1 {
		if len(links) > 1 {
			return ProductionCanvasAcquireResult{}, productionCanvasLinksConflict(links)
		}
		return ProductionCanvasAcquireResult{}, gorm.ErrRecordNotFound
	}
	var canvas model.CanvasProject
	if err := r.db.First(&canvas, "id = ? AND user_id = ? AND project_id = ?", links[0].CanvasID, input.UserID, input.ProjectID).Error; err != nil {
		return ProductionCanvasAcquireResult{}, ErrProductionCanvasConflict
	}
	guard, audit, err := productionCanvasReceipt(r.db, input.ProjectID, input.UnitID, links[0])
	if err != nil {
		return ProductionCanvasAcquireResult{}, err
	}
	return ProductionCanvasAcquireResult{Canvas: canvas, Link: links[0], Guard: guard, AuditEvent: audit, ProjectRevision: project.Revision, Created: false}, nil
}

func isProductionCanvasConcurrentWriteError(err error) bool {
	value := strings.ToLower(err.Error())
	return strings.Contains(value, "idx_production_canvas_guard_unit") || strings.Contains(value, "production_canvas_guards") || strings.Contains(value, "database is locked") || strings.Contains(value, "database table is locked")
}

func productionCanvasLinksConflict(links []model.CanvasUnitLink) error {
	canvasIDs := make([]string, 0, len(links))
	for _, link := range links {
		canvasIDs = append(canvasIDs, link.CanvasID)
	}
	return &ProductionCanvasConflictError{CanvasIDs: canvasIDs}
}

func productionCanvasReceipt(db *gorm.DB, projectID string, unitID string, link model.CanvasUnitLink) (model.ProductionCanvasGuard, model.AdminAuditEvent, error) {
	var guard model.ProductionCanvasGuard
	err := db.Session(&gorm.Session{NewDB: true}).First(&guard, "project_id = ? AND unit_id = ?", projectID, unitID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		// 旧 production 关联可读可复用，但不伪造历史 Human/Audit 证据。
		return model.ProductionCanvasGuard{}, model.AdminAuditEvent{}, nil
	}
	if err != nil {
		return model.ProductionCanvasGuard{}, model.AdminAuditEvent{}, err
	}
	if guard.CanvasID != link.CanvasID || guard.LinkID != link.ID || guard.AuditEventID == "" {
		return model.ProductionCanvasGuard{}, model.AdminAuditEvent{}, ErrProductionCanvasConflict
	}
	var audit model.AdminAuditEvent
	if err := db.Session(&gorm.Session{NewDB: true}).First(&audit, "id = ? AND action = ? AND target_type = ? AND target_id = ?", guard.AuditEventID, "production_canvas.acquire", "production_canvas", guard.CanvasID).Error; err != nil {
		return model.ProductionCanvasGuard{}, model.AdminAuditEvent{}, ErrProductionCanvasConflict
	}
	return guard, audit, nil
}
