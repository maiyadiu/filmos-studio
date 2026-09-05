package repository

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
)

var ErrScriptRevisionConflict = errors.New("script revision conflict")
var ErrScriptRequestConflict = errors.New("script request id reused with different input")

type ScriptRevisionWrite struct {
	UserID           string
	ExpectedRevision int64
	Unit             model.ProjectUnit
	Revision         model.ProjectUnitRevision
	InitialID        string
}

type ScriptRevisionResult struct {
	Unit     model.ProjectUnit         `json:"unit"`
	Revision model.ProjectUnitRevision `json:"revision"`
	Replayed bool                      `json:"replayed"`
}

func ScriptSourceHash(text string) string {
	digest := sha256.Sum256([]byte(text))
	return hex.EncodeToString(digest[:])
}

func (r *Repository) ProjectUnitRevisions(projectID, unitID string) ([]model.ProjectUnitRevision, error) {
	rows := []model.ProjectUnitRevision{}
	err := r.db.Omit("source_text").Where("project_id = ? AND unit_id = ?", projectID, unitID).Order("revision desc").Limit(50).Find(&rows).Error
	return rows, err
}

func (r *Repository) ProjectUnitRevision(projectID, unitID string, revision int64) (model.ProjectUnitRevision, error) {
	var row model.ProjectUnitRevision
	err := r.db.Where("project_id = ? AND unit_id = ? AND revision = ?", projectID, unitID, revision).First(&row).Error
	return row, err
}

func (r *Repository) SaveProjectUnitRevision(input ScriptRevisionWrite) (ScriptRevisionResult, error) {
	var result ScriptRevisionResult
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var current model.ProjectUnit
		if err := tx.Where("id = ? AND project_id = ?", input.Unit.ID, input.Unit.ProjectID).First(&current).Error; err != nil {
			return err
		}
		var prior model.ProjectUnitRevision
		err := tx.Where("unit_id = ? AND project_id = ? AND request_id = ?", current.ID, current.ProjectID, input.Revision.RequestID).First(&prior).Error
		if err == nil {
			if prior.RequestHash != input.Revision.RequestHash {
				return ErrScriptRequestConflict
			}
			result = ScriptRevisionResult{Unit: current, Revision: prior, Replayed: true}
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if current.Revision != input.ExpectedRevision {
			return ErrScriptRevisionConflict
		}
		// CAS, initial snapshot, revision, and project invalidation are one commit.
		// A failure must not leave a changed chapter without its recovery history.
		now := time.Now()
		update := tx.Model(&model.ProjectUnit{}).Where("id = ? AND project_id = ? AND revision = ?", current.ID, current.ProjectID, input.ExpectedRevision).
			Updates(map[string]any{"title": input.Unit.Title, "source_text": input.Unit.SourceText, "status": input.Unit.Status, "revision": current.Revision + 1, "updated_at": now})
		if update.Error != nil {
			return update.Error
		}
		if update.RowsAffected != 1 {
			return ErrScriptRevisionConflict
		}
		initial := model.ProjectUnitRevision{ID: input.InitialID, ProjectID: current.ProjectID, UnitID: current.ID, Revision: current.Revision, Title: current.Title, SourceText: current.SourceText, SourceHash: ScriptSourceHash(current.SourceText), Status: current.Status, RequestID: "baseline:" + current.ID, Note: "首次修订前的原始正文", CreatedAt: current.UpdatedAt}
		if err := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "unit_id"}, {Name: "revision"}}, DoNothing: true}).Create(&initial).Error; err != nil {
			return err
		}
		next := input.Revision
		next.UnitID, next.ProjectID, next.Revision = current.ID, current.ProjectID, current.Revision+1
		next.Title, next.SourceText, next.Status = input.Unit.Title, input.Unit.SourceText, input.Unit.Status
		next.SourceHash, next.CreatedAt, next.CreatedBy = ScriptSourceHash(next.SourceText), now, input.UserID
		if err := tx.Create(&next).Error; err != nil {
			return err
		}
		project := tx.Model(&model.Project{}).Where("id = ? AND user_id = ? AND status = ?", current.ProjectID, input.UserID, model.ProjectStatusActive).
			Updates(map[string]any{"revision": gorm.Expr("revision + 1"), "updated_at": now})
		if project.Error != nil {
			return project.Error
		}
		if project.RowsAffected != 1 {
			return ErrScriptRevisionConflict
		}
		current.Title, current.SourceText, current.Status = next.Title, next.SourceText, next.Status
		current.Revision, current.UpdatedAt = next.Revision, now
		result = ScriptRevisionResult{Unit: current, Revision: next}
		return nil
	})
	return result, err
}
