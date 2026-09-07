package repository

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
)

// Callback reads dependencies and appends history through the same transaction.
// The final JSON CAS prevents a second service instance from losing row/layout
// changes. An error rolls back the prompt, its history and its receipt together.
func (r *Repository) ChangeCanvasPrompt(userID, canvasID string, change func(*Repository, model.CanvasProject) (string, error)) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var current model.CanvasProject
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND user_id = ?", canvasID, userID).First(&current).Error; err != nil {
			return err
		}
		next, err := change(New(tx), current)
		if err != nil {
			return err
		}
		if next == current.PayloadJSON {
			return nil
		}
		result := tx.Model(&model.CanvasProject{}).Where("id = ? AND user_id = ? AND payload_json = ?", canvasID, userID, current.PayloadJSON).Updates(map[string]any{"payload_json": next, "updated_at": time.Now()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return model.ErrCanvasPromptConflict
		}
		return nil
	}, &sql.TxOptions{Isolation: sql.LevelSerializable})
}

// One consistent snapshot for prompt text, history and all source dependencies.
func (r *Repository) ReadCanvasPrompt(userID, canvasID string, read func(*Repository, model.CanvasProject) error) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		current, err := New(tx).CanvasProjectForUser(userID, canvasID)
		if err != nil {
			return err
		}
		return read(New(tx), *current)
	}, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
}

// Explicit detach may remove projectId, but cannot replay an old document over
// a concurrently saved prompt (or any other canvas edit).
func validateCanvasDetachment(before, after string) error {
	var old, next map[string]json.RawMessage
	if json.Unmarshal([]byte(before), &old) != nil || old == nil || json.Unmarshal([]byte(after), &next) != nil || next == nil {
		return model.ErrCanvasPromptConflict
	}
	if model.CanvasJSONText(next, "projectId") != "" {
		return model.ErrCanvasPromptConflict
	}
	for _, doc := range []map[string]json.RawMessage{old, next} {
		delete(doc, "projectId")
		delete(doc, "updatedAt")
	}
	a, _ := json.Marshal(old)
	b, _ := json.Marshal(next)
	if string(a) != string(b) {
		return model.ErrCanvasPromptConflict
	}
	return nil
}

func (r *Repository) CanvasPromptReceipt(userID, canvasID, requestID string) (model.CanvasPromptReceipt, error) {
	var receipt model.CanvasPromptReceipt
	err := r.db.Where("user_id = ? AND canvas_id = ? AND request_id = ?", userID, canvasID, requestID).First(&receipt).Error
	return receipt, err
}

func (r *Repository) CanvasPromptRevisions(userID, canvasID, nodeID, rowID, kind string) ([]model.CanvasPromptRevision, error) {
	rows := []model.CanvasPromptRevision{}
	err := r.db.Where("user_id = ? AND canvas_id = ? AND node_id = ? AND row_id = ? AND kind = ?", userID, canvasID, nodeID, rowID, kind).Order("revision desc").Limit(50).Find(&rows).Error
	return rows, err
}

func (r *Repository) CanvasPromptRevision(userID, canvasID, nodeID, rowID, kind string, revision int64) (model.CanvasPromptRevision, error) {
	var row model.CanvasPromptRevision
	err := r.db.Where("user_id = ? AND canvas_id = ? AND node_id = ? AND row_id = ? AND kind = ? AND revision = ?", userID, canvasID, nodeID, rowID, kind, revision).First(&row).Error
	return row, err
}

func (r *Repository) CanvasPromptRevisionSummaries(userID, canvasID, nodeID, rowID, kind string) ([]model.CanvasPromptRevision, error) {
	rows := []model.CanvasPromptRevision{}
	err := r.db.Select("revision", "content_hash", "dependency_hash", "request_id", "created_at").Where("user_id = ? AND canvas_id = ? AND node_id = ? AND row_id = ? AND kind = ?", userID, canvasID, nodeID, rowID, kind).Order("revision desc").Limit(50).Find(&rows).Error
	return rows, err
}

func (r *Repository) AppendCanvasPromptRevision(row model.CanvasPromptRevision, baseline bool) error {
	if baseline {
		return r.db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "canvas_id"}, {Name: "node_id"}, {Name: "row_id"}, {Name: "kind"}, {Name: "revision"}}, DoNothing: true}).Create(&row).Error
	}
	return r.db.Create(&row).Error
}

func (r *Repository) AppendCanvasPromptReceipt(row model.CanvasPromptReceipt) error {
	return r.db.Create(&row).Error
}

func (r *Repository) upsertCanvasProjectPreservingPrompts(project *model.CanvasProject, expectedContentHash *string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var current model.CanvasProject
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND user_id = ?", project.ID, project.UserID).First(&current).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			if expectedContentHash != nil && *expectedContentHash != "" {
				return model.ErrCanvasContentConflict
			}
			if err := model.ValidateCanvasPromptPreservation([]byte(`{"nodes":[]}`), []byte(project.PayloadJSON)); err != nil {
				return err
			}
			return tx.Create(project).Error
		}
		if err != nil {
			return err
		}
		if expectedContentHash != nil && *expectedContentHash != model.CanvasContentHash([]byte(current.PayloadJSON)) {
			return model.ErrCanvasContentConflict
		}
		if current.ProjectID != project.ProjectID {
			if err := rejectBoundChapterCanvas(tx, project.ID); err != nil {
				return err
			}
		}
		if err := model.ValidateCanvasPromptPreservation([]byte(current.PayloadJSON), []byte(project.PayloadJSON)); err != nil {
			return err
		}
		result := tx.Model(&model.CanvasProject{}).Where("id = ? AND user_id = ? AND payload_json = ?", project.ID, project.UserID, current.PayloadJSON).Updates(map[string]any{"project_id": project.ProjectID, "title": project.Title, "payload_json": project.PayloadJSON, "updated_at": project.UpdatedAt})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			if expectedContentHash != nil {
				return model.ErrCanvasContentConflict
			}
			return model.ErrCanvasPromptConflict
		}
		return nil
	})
}
