package service

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type AcquireChapterCanvasRequest struct {
	CanvasID string `json:"canvasId,omitempty"`
}

func chapterCanvasError(err error) error {
	if errors.Is(err, repository.ErrChapterCanvasIdentity) {
		return WrapAppError(409, repository.ErrChapterCanvasIdentity.Error(), err)
	}
	if errors.Is(err, repository.ErrChapterCanvasArchived) {
		return WrapAppError(409, repository.ErrChapterCanvasArchived.Error(), err)
	}
	if errors.Is(err, repository.ErrChapterCanvasBinding) {
		return WrapAppError(409, repository.ErrChapterCanvasBinding.Error(), err)
	}
	return err
}

func (s *Service) AcquireChapterCanvas(userID, projectID, unitID string, req AcquireChapterCanvasRequest) (_ repository.ChapterCanvasAcquireResult, resultErr error) {
	projectID, unitID = strings.TrimSpace(projectID), strings.TrimSpace(unitID)
	finish, err := s.beginProjectDirectoryWrite(userID, projectID)
	if err != nil {
		return repository.ChapterCanvasAcquireResult{}, err
	}
	defer finish(&resultErr)
	if _, err := s.repo.ProjectForUser(userID, projectID); err != nil {
		return repository.ChapterCanvasAcquireResult{}, err
	}
	unit, err := s.repo.ProjectUnit(projectID, unitID)
	if err != nil {
		return repository.ChapterCanvasAcquireResult{}, err
	}
	if unit.Kind != model.ProjectUnitKindChapter && unit.Kind != model.ProjectUnitKindEpisode {
		return repository.ChapterCanvasAcquireResult{}, BadAuthRequest("仅章节或剧集可以取得章节画布")
	}
	now, canvasID := time.Now().UTC(), newID()
	// Ordinary Host canvas only: no production flag, confirmation or audit
	// authority is fabricated. Storyboard import follows the existing CAS path.
	document := productionCanvasDocument{ID: canvasID, ProjectID: projectID, Title: unit.Title + " · 画布", CreatedAt: now.Format(time.RFC3339Nano), UpdatedAt: now.Format(time.RFC3339Nano), Nodes: []any{}, Connections: []any{}, ChatSessions: []any{}, BackgroundMode: "dots", ShowImageInfo: true, Viewport: map[string]float64{"x": 0, "y": 0, "k": 1}, DirectorScenes: []any{}}
	payload, err := json.Marshal(document)
	if err != nil {
		return repository.ChapterCanvasAcquireResult{}, err
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return repository.ChapterCanvasAcquireResult{}, err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	result, err := s.repo.AcquireChapterCanvas(repository.ChapterCanvasAcquireInput{
		UserID: userID, ProjectID: projectID, UnitID: unitID, PreferredCanvasID: strings.TrimSpace(req.CanvasID),
		Canvas: model.CanvasProject{ID: canvasID, UserID: userID, ProjectID: projectID, Title: document.Title, PayloadJSON: string(payload), CreatedAt: now, UpdatedAt: now},
		Link:   model.CanvasUnitLink{ID: newID(), ProjectID: projectID, UnitID: unitID, CanvasID: canvasID, Role: "storyboard", CreatedAt: now},
		BeforeCreate: func(tx *repository.Repository, canvas model.CanvasProject) error {
			usage, err := tx.UserStorageUsage(userID)
			if err != nil {
				return err
			}
			return validateStructuredStorageQuotaWithPolicy(usage, "canvas", true, int64(len(canvas.PayloadJSON)), policy.Resource)
		},
	})
	if result.Canvas != nil {
		result.Canvas.PayloadJSON = ""
	}
	return result, chapterCanvasError(err)
}
