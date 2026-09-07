package repository

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
)

var ErrChapterCanvasBinding = errors.New("章节已有唯一画布，不能解绑、改挂或另建；仅删除原画布后可以重建")
var ErrChapterCanvasArchived = errors.New("项目已归档，不能新建或指定章节画布")
var ErrChapterCanvasIdentity = errors.New("画布文档身份与项目关联不一致，请核对历史数据；未改写或新建画布")

type ChapterCanvasAcquireInput struct {
	UserID, ProjectID, UnitID, PreferredCanvasID string
	Canvas                                       model.CanvasProject
	Link                                         model.CanvasUnitLink
	BeforeCreate                                 func(*Repository, model.CanvasProject) error
}

type ChapterCanvasAcquireResult struct {
	Canvas      *model.CanvasProject  `json:"canvas,omitempty"`
	Candidates  []model.CanvasProject `json:"candidates,omitempty"`
	Disposition string                `json:"disposition"`
}

// Take a write lock before reading the empty binding. UPDATE-column avoids a
// deferred SQLite read-to-write upgrade; PostgreSQL locks the same project row.
// The chapter pointer and unique canvas index remain the persistent authority.
func (r *Repository) chapterCanvasTransaction(userID, projectID string, operation func(*gorm.DB) error) error {
	for attempt := 0; ; attempt++ {
		err := r.db.Transaction(func(tx *gorm.DB) error {
			lock := tx.Model(&model.Project{}).Where("id = ? AND user_id = ?", projectID, userID).UpdateColumn("revision", gorm.Expr("revision"))
			if lock.Error != nil {
				return lock.Error
			}
			if lock.RowsAffected != 1 {
				return gorm.ErrRecordNotFound
			}
			return operation(tx)
		})
		if err == nil || r.Dialect() != "sqlite" || attempt >= 7 {
			return err
		}
		message := strings.ToLower(err.Error())
		if !strings.Contains(message, "database is locked") && !strings.Contains(message, "database table is locked") {
			return err
		}
		time.Sleep(time.Duration(attempt+1) * 10 * time.Millisecond)
	}
}

func (r *Repository) AcquireChapterCanvas(input ChapterCanvasAcquireInput) (ChapterCanvasAcquireResult, error) {
	var result ChapterCanvasAcquireResult
	err := r.chapterCanvasTransaction(input.UserID, input.ProjectID, func(tx *gorm.DB) error {
		result = ChapterCanvasAcquireResult{}
		var project model.Project
		if err := tx.First(&project, "id = ? AND user_id = ?", input.ProjectID, input.UserID).Error; err != nil {
			return err
		}
		var unit model.ProjectUnit
		if err := tx.First(&unit, "id = ? AND project_id = ?", input.UnitID, input.ProjectID).Error; err != nil {
			return err
		}
		if unit.ChapterCanvasID != nil {
			if input.PreferredCanvasID != "" && input.PreferredCanvasID != *unit.ChapterCanvasID {
				return ErrChapterCanvasBinding
			}
			var canvas model.CanvasProject
			if err := tx.First(&canvas, "id = ? AND user_id = ? AND project_id = ?", *unit.ChapterCanvasID, input.UserID, input.ProjectID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrChapterCanvasBinding
				}
				return err
			}
			if err := validateChapterCanvasIdentity(canvas); err != nil {
				return err
			}
			result = ChapterCanvasAcquireResult{Canvas: &canvas, Disposition: "reused"}
			var links int64
			if err := tx.Model(&model.CanvasUnitLink{}).Where("project_id = ? AND unit_id = ? AND canvas_id = ?", input.ProjectID, input.UnitID, canvas.ID).Count(&links).Error; err != nil {
				return err
			}
			if links != 1 {
				return ErrChapterCanvasBinding
			}
			return nil
		}
		if project.Status == model.ProjectStatusArchived {
			return ErrChapterCanvasArchived
		}
		// Legacy links are not rewritten. Multiple historical canvases require an
		// explicit selection; listing them must not create another blank canvas.
		var candidates []model.CanvasProject
		if err := tx.Model(&model.CanvasProject{}).Distinct("canvas_projects.*").
			Joins("JOIN canvas_unit_links l ON l.canvas_id = canvas_projects.id AND l.project_id = canvas_projects.project_id").
			Where("canvas_projects.user_id = ? AND canvas_projects.project_id = ? AND l.unit_id = ? AND l.role IN ?", input.UserID, input.ProjectID, input.UnitID, []string{"storyboard", "production"}).
			Order("canvas_projects.created_at asc, canvas_projects.id asc").Find(&candidates).Error; err != nil {
			return err
		}
		var selected *model.CanvasProject
		if input.PreferredCanvasID != "" {
			for i := range candidates {
				if candidates[i].ID == input.PreferredCanvasID {
					selected = &candidates[i]
				}
			}
			if selected == nil {
				return ErrChapterCanvasBinding
			}
		} else if len(candidates) == 1 {
			selected = &candidates[0]
		} else if len(candidates) > 1 {
			for i := range candidates {
				candidates[i].PayloadJSON = ""
			}
			result = ChapterCanvasAcquireResult{Candidates: candidates, Disposition: "selection_required"}
			return nil
		}
		disposition := "adopted"
		if selected == nil {
			canvas := input.Canvas
			if input.BeforeCreate != nil {
				if err := input.BeforeCreate(New(tx), canvas); err != nil {
					return err
				}
			}
			if err := tx.Create(&canvas).Error; err != nil {
				return err
			}
			link := input.Link
			if err := tx.Create(&link).Error; err != nil {
				return err
			}
			selected, disposition = &canvas, "created"
		} else {
			var fresh model.CanvasProject
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&fresh, "id = ? AND user_id = ? AND project_id = ?", selected.ID, input.UserID, input.ProjectID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrChapterCanvasBinding
				}
				return err
			}
			selected = &fresh
			var count int64
			if err := tx.Model(&model.CanvasUnitLink{}).Where("canvas_id = ? AND unit_id <> ? AND role IN ?", selected.ID, unit.ID, []string{"storyboard", "production"}).Count(&count).Error; err != nil {
				return err
			}
			if count != 0 {
				return ErrChapterCanvasBinding
			}
		}
		if err := validateChapterCanvasIdentity(*selected); err != nil {
			return err
		}
		var occupied int64
		if err := tx.Model(&model.ProjectUnit{}).Where("chapter_canvas_id = ? AND id <> ?", selected.ID, unit.ID).Count(&occupied).Error; err != nil {
			return err
		}
		if occupied != 0 {
			return ErrChapterCanvasBinding
		}
		bound := tx.Model(&model.ProjectUnit{}).Where("id = ? AND project_id = ? AND chapter_canvas_id IS NULL", unit.ID, unit.ProjectID).UpdateColumn("chapter_canvas_id", selected.ID)
		if bound.Error != nil {
			return bound.Error
		}
		if bound.RowsAffected != 1 {
			return ErrChapterCanvasBinding
		}
		if err := tx.Model(&model.Project{}).Where("id = ?", project.ID).Updates(map[string]any{"revision": gorm.Expr("revision + 1"), "updated_at": time.Now()}).Error; err != nil {
			return err
		}
		result = ChapterCanvasAcquireResult{Canvas: selected, Disposition: disposition}
		return nil
	})
	return result, err
}

func validateChapterCanvasIdentity(canvas model.CanvasProject) error {
	var identity struct {
		ID        string `json:"id"`
		ProjectID string `json:"projectId"`
	}
	if err := json.Unmarshal([]byte(canvas.PayloadJSON), &identity); err != nil || identity.ID != canvas.ID || identity.ProjectID != canvas.ProjectID {
		return ErrChapterCanvasIdentity
	}
	return nil
}

func rejectBoundChapterCanvas(tx *gorm.DB, canvasID string) error {
	var count int64
	if err := tx.Model(&model.ProjectUnit{}).Where("chapter_canvas_id = ?", canvasID).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return ErrChapterCanvasBinding
	}
	return nil
}

func checkChapterLink(tx *gorm.DB, link *model.CanvasUnitLink) error {
	var unit model.ProjectUnit
	if err := tx.First(&unit, "id = ? AND project_id = ?", link.UnitID, link.ProjectID).Error; err != nil {
		return err
	}
	if unit.ChapterCanvasID != nil && *unit.ChapterCanvasID != link.CanvasID {
		return ErrChapterCanvasBinding
	}
	var count int64
	if err := tx.Model(&model.ProjectUnit{}).Where("chapter_canvas_id = ? AND id <> ?", link.CanvasID, link.UnitID).Count(&count).Error; err != nil {
		return err
	}
	if count != 0 {
		return ErrChapterCanvasBinding
	}
	return nil
}
