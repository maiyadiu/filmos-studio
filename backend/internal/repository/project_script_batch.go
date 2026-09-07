package repository

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

type ScriptBatchWrite struct {
	UserID                  string
	ExpectedProjectRevision int64
	Receipt                 model.ProjectScriptBatch
	Units                   []model.ProjectUnit
	Revisions               []model.ProjectUnitRevision
}

func (r *Repository) ProjectScriptBatch(projectID, requestID string) (model.ProjectScriptBatch, error) {
	var row model.ProjectScriptBatch
	err := r.db.Where("project_id = ? AND request_id = ?", projectID, requestID).First(&row).Error
	return row, err
}

func (r *Repository) CreateProjectScriptBatch(input ScriptBatchWrite) (model.ProjectScriptBatch, bool, error) {
	var receipt model.ProjectScriptBatch
	replayed := false
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var project model.Project
		if err := tx.Where("id = ? AND user_id = ? AND status = ?", input.Receipt.ProjectID, input.UserID, model.ProjectStatusActive).First(&project).Error; err != nil {
			return err
		}
		err := tx.Where("project_id = ? AND request_id = ?", project.ID, input.Receipt.RequestID).First(&receipt).Error
		if err == nil {
			if receipt.RequestHash != input.Receipt.RequestHash {
				return ErrScriptRequestConflict
			}
			replayed = true
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if project.Revision != input.ExpectedProjectRevision {
			return ErrScriptRevisionConflict
		}
		now := time.Now()
		update := tx.Model(&model.Project{}).Where("id = ? AND user_id = ? AND revision = ? AND status = ?", project.ID, input.UserID, input.ExpectedProjectRevision, model.ProjectStatusActive).
			Updates(map[string]any{"revision": project.Revision + 1, "updated_at": now})
		if update.Error != nil {
			return update.Error
		}
		if update.RowsAffected != 1 {
			return ErrScriptRevisionConflict
		}
		var position int
		if err := tx.Model(&model.ProjectUnit{}).Select("COALESCE(MAX(position), -1) + 1").Where("project_id = ?", project.ID).Scan(&position).Error; err != nil {
			return err
		}
		for i := range input.Units {
			input.Units[i].Position = position + i
		}
		if err := tx.CreateInBatches(&input.Units, 50).Error; err != nil {
			return err
		}
		if err := tx.CreateInBatches(&input.Revisions, 50).Error; err != nil {
			return err
		}
		receipt = input.Receipt
		receipt.ProjectRevision, receipt.CreatedAt = project.Revision+1, now
		return tx.Create(&receipt).Error
	})
	return receipt, replayed, err
}
