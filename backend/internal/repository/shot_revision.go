package repository

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
)

var ErrShotRevisionConflict = errors.New("shot or source revision conflict")
var ErrShotRequestConflict = errors.New("shot request id reused with different input")

type ShotWrite struct {
	Shot             model.Shot
	ExpectedRevision int64
}
type ShotBatchWrite struct {
	UserID               string
	Unit                 model.ProjectUnit
	ExpectedShotRevision int64
	Writes               []ShotWrite
	Receipt              model.ShotBatchReceipt
}
type ShotBatchResult struct {
	Receipt  model.ShotBatchReceipt `json:"receipt"`
	Replayed bool                   `json:"replayed"`
}

func (r *Repository) ProjectShotBatch(projectID, unitID, requestID string) (model.ShotBatchReceipt, error) {
	var row model.ShotBatchReceipt
	err := r.db.Where("project_id = ? AND unit_id = ? AND request_id = ?", projectID, unitID, requestID).First(&row).Error
	return row, err
}

func (r *Repository) ProjectShotRevisions(projectID, shotID string) ([]model.ShotRevision, error) {
	rows := []model.ShotRevision{}
	err := r.db.Where("project_id = ? AND shot_id = ?", projectID, shotID).Order("revision desc").Find(&rows).Error
	return rows, err
}

func shotSnapshot(shot model.Shot, requestID, userID string) (model.ShotRevision, error) {
	body, err := json.Marshal(shot)
	return model.ShotRevision{ID: uuid.NewString(), ProjectID: shot.ProjectID, UnitID: shot.UnitID, ShotID: shot.ID, Revision: shot.Revision, Snapshot: shot, ContentHash: ScriptSourceHash(string(body)), RequestID: requestID, CreatedBy: userID, CreatedAt: time.Now()}, err
}

// All Shot writers use the same CAS/history path. Source rows are locked before
// shots, and project invalidation is last, matching the chapter edit lock order.
func saveShotRevision(tx *gorm.DB, write ShotWrite, requestID, userID string) (model.Shot, error) {
	next := write.Shot
	if write.ExpectedRevision == 0 {
		next.Revision = 1
		if err := tx.Create(&next).Error; err != nil {
			return next, err
		}
	} else {
		var current model.Shot
		if err := tx.Where("id = ? AND project_id = ?", next.ID, next.ProjectID).First(&current).Error; err != nil {
			return next, err
		}
		if current.Revision != write.ExpectedRevision || current.UnitID != next.UnitID {
			return next, ErrShotRevisionConflict
		}
		initial, err := shotSnapshot(current, "baseline:"+current.ID, userID)
		if err != nil {
			return next, err
		}
		if err := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "shot_id"}, {Name: "revision"}}, DoNothing: true}).Create(&initial).Error; err != nil {
			return next, err
		}
		next.Revision = current.Revision + 1
		next.CreatedAt = current.CreatedAt
		update := tx.Model(&model.Shot{}).Where("id = ? AND project_id = ? AND revision = ?", next.ID, next.ProjectID, current.Revision).
			Select("title", "description", "position", "duration_ms", "status", "revision", "source_revision", "source_hash", "content", "updated_at").Updates(&next)
		if update.Error != nil {
			return next, update.Error
		}
		if update.RowsAffected != 1 {
			return next, ErrShotRevisionConflict
		}
	}
	// Snapshot the stored row, including ORM-managed timestamps and database
	// precision, so the receipt is byte-for-byte the persisted business object.
	var persisted model.Shot
	if err := tx.Where("id = ? AND project_id = ?", next.ID, next.ProjectID).First(&persisted).Error; err != nil {
		return next, err
	}
	next = persisted
	row, err := shotSnapshot(next, requestID, userID)
	if err != nil {
		return next, err
	}
	return next, tx.Create(&row).Error
}

func bumpShotProject(tx *gorm.DB, projectID, userID string) error {
	result := tx.Model(&model.Project{}).Where("id = ? AND user_id = ? AND status = ?", projectID, userID, model.ProjectStatusActive).
		Updates(map[string]any{"revision": gorm.Expr("revision + 1"), "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrShotRevisionConflict
	}
	return nil
}

func (r *Repository) SaveShotVersion(write ShotWrite, userID string) (model.Shot, error) {
	var saved model.Shot
	err := r.db.Transaction(func(tx *gorm.DB) error {
		if write.Shot.UnitID != "" {
			unit := tx.Model(&model.ProjectUnit{}).Where("id = ? AND project_id = ? AND status IN ?", write.Shot.UnitID, write.Shot.ProjectID, []model.ProjectUnitStatus{model.ProjectUnitStatusDraft, model.ProjectUnitStatusReady}).Update("shot_revision", gorm.Expr("shot_revision + 1"))
			if unit.Error != nil {
				return unit.Error
			}
			if unit.RowsAffected != 1 {
				return ErrShotRevisionConflict
			}
			var occupied int64
			if err := tx.Model(&model.Shot{}).Where("project_id = ? AND unit_id = ? AND position = ? AND id <> ?", write.Shot.ProjectID, write.Shot.UnitID, write.Shot.Position, write.Shot.ID).Count(&occupied).Error; err != nil {
				return err
			}
			if occupied != 0 {
				return ErrShotRevisionConflict
			}
		}
		var err error
		saved, err = saveShotRevision(tx, write, "manual:"+uuid.NewString(), userID)
		if err != nil {
			return err
		}
		return bumpShotProject(tx, write.Shot.ProjectID, userID)
	})
	return saved, err
}

func (r *Repository) SaveShotBatch(input ShotBatchWrite) (ShotBatchResult, error) {
	var result ShotBatchResult
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var prior model.ShotBatchReceipt
		err := tx.Where("unit_id = ? AND project_id = ? AND request_id = ?", input.Unit.ID, input.Unit.ProjectID, input.Receipt.RequestID).First(&prior).Error
		if err == nil {
			if prior.RequestHash != input.Receipt.RequestHash {
				return ErrShotRequestConflict
			}
			result = ShotBatchResult{Receipt: prior, Replayed: true}
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		unit := tx.Model(&model.ProjectUnit{}).Where("id = ? AND project_id = ? AND revision = ? AND source_text = ? AND shot_revision = ? AND status IN ?", input.Unit.ID, input.Unit.ProjectID, input.Unit.Revision, input.Unit.SourceText, input.ExpectedShotRevision, []model.ProjectUnitStatus{model.ProjectUnitStatusDraft, model.ProjectUnitStatusReady}).Update("shot_revision", input.ExpectedShotRevision+1)
		if unit.Error != nil {
			return unit.Error
		}
		if unit.RowsAffected != 1 {
			return ErrShotRevisionConflict
		}
		var existing []model.Shot
		if err := tx.Where("project_id = ? AND unit_id = ?", input.Unit.ProjectID, input.Unit.ID).Find(&existing).Error; err != nil {
			return err
		}
		positions := map[string]int{}
		for _, shot := range existing {
			positions[shot.ID] = shot.Position
		}
		for _, write := range input.Writes {
			positions[write.Shot.ID] = write.Shot.Position
		}
		used := map[int]bool{}
		for _, position := range positions {
			if used[position] {
				return ErrShotRevisionConflict
			}
			used[position] = true
		}
		shots := []model.Shot{}
		for _, write := range input.Writes {
			shot, err := saveShotRevision(tx, write, input.Receipt.RequestID, input.UserID)
			if err != nil {
				return err
			}
			shots = append(shots, shot)
		}
		receipt := input.Receipt
		receipt.Shots, receipt.ShotRevision = shots, input.ExpectedShotRevision+1
		if err := tx.Create(&receipt).Error; err != nil {
			return err
		}
		var persistedReceipt model.ShotBatchReceipt
		if err := tx.Where("id = ?", receipt.ID).First(&persistedReceipt).Error; err != nil {
			return err
		}
		if err := bumpShotProject(tx, input.Unit.ProjectID, input.UserID); err != nil {
			return err
		}
		result = ShotBatchResult{Receipt: persistedReceipt}
		return nil
	})
	return result, err
}
