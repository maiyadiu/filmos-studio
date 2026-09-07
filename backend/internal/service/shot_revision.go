package service

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type SaveProjectUnitShotsRequest struct {
	RequestID            string                    `json:"requestId"`
	ExpectedShotRevision *int64                    `json:"expectedShotRevision"`
	SourceRevision       int64                     `json:"sourceRevision"`
	SourceHash           string                    `json:"sourceHash"`
	SourceParagraphIDs   []string                  `json:"sourceParagraphIds"`
	Shots                []ProjectShotWriteRequest `json:"shots"`
}
type ProjectShotWriteRequest struct {
	ID               string            `json:"id,omitempty"`
	ExpectedRevision int64             `json:"expectedRevision"`
	Title            string            `json:"title"`
	Description      string            `json:"description"`
	Position         int               `json:"position"`
	DurationMs       int64             `json:"durationMs"`
	Content          model.ShotContent `json:"content"`
}
type ProjectShotContext struct {
	Unit         model.ProjectUnit  `json:"unit"`
	SourceHash   string             `json:"sourceHash"`
	Paragraphs   []ScriptParagraph  `json:"paragraphs"`
	Shots        []model.Shot       `json:"shots"`
	StaleShotIDs []string           `json:"staleShotIds"`
	Coverage     ShotSourceCoverage `json:"coverage"`
}

func (s *Service) GetProjectShotContext(userID, projectID, unitID string) (ProjectShotContext, error) {
	unit, err := s.GetProjectUnit(userID, projectID, unitID)
	if err != nil {
		return ProjectShotContext{}, shotWriteError(err)
	}
	shots, err := s.repo.ProjectUnitShots(projectID, unitID)
	if err != nil {
		return ProjectShotContext{}, shotWriteError(err)
	}
	hash := repository.ScriptSourceHash(unit.SourceText)
	stale := []string{}
	fresh := []model.Shot{}
	for _, shot := range shots {
		if shot.SourceHash != hash || shot.SourceRevision != unit.Revision {
			stale = append(stale, shot.ID)
		} else {
			fresh = append(fresh, shot)
		}
	}
	paragraphs := scriptParagraphs(unit.SourceText)
	return ProjectShotContext{Unit: unit, SourceHash: hash, Paragraphs: paragraphs, Shots: shots, StaleShotIDs: stale, Coverage: shotSourceCoverage(paragraphs, fresh, nil)}, nil
}

func (s *Service) GetProjectShotRevisions(userID, projectID, shotID string) ([]model.ShotRevision, error) {
	if _, err := s.repo.ProjectForUser(userID, projectID); err != nil {
		return nil, shotWriteError(err)
	}
	if _, err := s.repo.ShotForProject(projectID, shotID); err != nil {
		return nil, shotWriteError(err)
	}
	rows, err := s.repo.ProjectShotRevisions(projectID, shotID)
	return rows, shotWriteError(err)
}

func (s *Service) GetProjectShotBatch(userID, projectID, unitID, requestID string) (model.ShotBatchReceipt, error) {
	if _, err := s.GetProjectUnit(userID, projectID, unitID); err != nil {
		return model.ShotBatchReceipt{}, shotWriteError(err)
	}
	row, err := s.repo.ProjectShotBatch(projectID, unitID, requestID)
	return row, shotWriteError(err)
}

func (s *Service) SaveProjectUnitShots(userID, projectID, unitID string, req SaveProjectUnitShotsRequest) (_ repository.ShotBatchResult, resultErr error) {
	finish, err := s.beginProjectDirectoryWrite(userID, projectID)
	if err != nil {
		return repository.ShotBatchResult{}, err
	}
	defer finish(&resultErr)
	project, err := s.repo.ProjectForUser(userID, projectID)
	if err != nil {
		return repository.ShotBatchResult{}, shotWriteError(err)
	}
	unit, err := s.repo.ProjectUnit(projectID, unitID)
	if err != nil {
		return repository.ShotBatchResult{}, shotWriteError(err)
	}
	if len(req.RequestID) > 100 || strings.TrimSpace(req.RequestID) == "" || req.ExpectedShotRevision == nil || *req.ExpectedShotRevision < 0 || req.SourceRevision < 1 || len(req.SourceHash) != 64 || len(req.Shots) < 1 || len(req.Shots) > 100 {
		return repository.ShotBatchResult{}, BadAuthRequest("需要本次requestId、读取到的章节/镜头版本、哈希和1–100个镜头")
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return repository.ShotBatchResult{}, err
	}
	if len(payload) > 2<<20 {
		return repository.ShotBatchResult{}, BadAuthRequest("镜头批次超过大小限制")
	}
	requestHash := repository.ScriptSourceHash(string(payload))
	prior, err := s.repo.ProjectShotBatch(projectID, unitID, req.RequestID)
	if err == nil {
		if prior.RequestHash != requestHash {
			return repository.ShotBatchResult{}, shotWriteError(repository.ErrShotRequestConflict)
		}
		return repository.ShotBatchResult{Receipt: prior, Replayed: true}, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return repository.ShotBatchResult{}, err
	}
	if project.Status != model.ProjectStatusActive || (unit.Status != model.ProjectUnitStatusDraft && unit.Status != model.ProjectUnitStatusReady) || unit.Revision != req.SourceRevision || repository.ScriptSourceHash(unit.SourceText) != req.SourceHash || unit.ShotRevision != *req.ExpectedShotRevision {
		return repository.ShotBatchResult{}, shotWriteError(repository.ErrShotRevisionConflict)
	}
	paragraphs := scriptParagraphs(unit.SourceText)
	writes := []repository.ShotWrite{}
	seen := map[string]bool{}
	for _, input := range req.Shots {
		if strings.TrimSpace(input.Title) == "" || len(input.Title) > 960 || strings.TrimSpace(input.Description) == "" || input.Position < 0 || input.DurationMs <= 0 || input.DurationMs > 3600000 {
			return repository.ShotBatchResult{}, BadAuthRequest("镜头标题、描述、顺序或时长无效；整批未写入")
		}
		if err := validateShotContent(input.Content, paragraphs); err != nil {
			return repository.ShotBatchResult{}, err
		}
		id := strings.TrimSpace(input.ID)
		status := "draft"
		if id == "" {
			if input.ExpectedRevision != 0 {
				return repository.ShotBatchResult{}, BadAuthRequest("新镜头expectedRevision必须为0")
			}
			id = newID()
		} else {
			if seen[id] {
				return repository.ShotBatchResult{}, BadAuthRequest("同一批次不能重复修改同一镜头")
			}
			existing, err := s.repo.ShotForProject(projectID, id)
			if err != nil {
				return repository.ShotBatchResult{}, shotWriteError(err)
			}
			if existing.UnitID != unitID || existing.Revision != input.ExpectedRevision || (existing.Status != "draft" && existing.Status != "ready") {
				return repository.ShotBatchResult{}, shotWriteError(repository.ErrShotRevisionConflict)
			}
			status = existing.Status
		}
		seen[id] = true
		shot := model.Shot{ID: id, ProjectID: projectID, UnitID: unitID, Title: strings.TrimSpace(input.Title), Description: input.Description, Position: input.Position, DurationMs: input.DurationMs, Status: status, SourceRevision: req.SourceRevision, SourceHash: req.SourceHash, Content: input.Content, CreatedAt: time.Now(), UpdatedAt: time.Now()}
		writes = append(writes, repository.ShotWrite{Shot: shot, ExpectedRevision: input.ExpectedRevision})
	}
	current, err := s.repo.ProjectUnitShots(projectID, unitID)
	if err != nil {
		return repository.ShotBatchResult{}, shotWriteError(err)
	}
	proposed := []model.Shot{}
	for _, write := range writes {
		proposed = append(proposed, write.Shot)
	}
	if err := validateShotSourceScope(paragraphs, current, proposed, req.SourceRevision, req.SourceHash, req.SourceParagraphIDs); err != nil {
		return repository.ShotBatchResult{}, err
	}
	// CAS checks the same chapter/source/shotRevision, so a concurrent writer
	// cannot invalidate the source preflight and still commit this batch.
	result, err := s.repo.SaveShotBatch(repository.ShotBatchWrite{UserID: userID, Unit: *unit, ExpectedShotRevision: *req.ExpectedShotRevision, Writes: writes, Receipt: model.ShotBatchReceipt{ID: newID(), ProjectID: projectID, UnitID: unitID, RequestID: req.RequestID, RequestHash: requestHash, SourceRevision: req.SourceRevision, SourceHash: req.SourceHash, SourceParagraphIDs: req.SourceParagraphIDs, CreatedBy: userID, CreatedAt: time.Now()}})
	return result, shotWriteError(err)
}

func shotWriteError(err error) error {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return NewAppError(http.StatusNotFound, "项目、章节、镜头或回执不存在")
	}
	if errors.Is(err, repository.ErrShotRevisionConflict) {
		return NewAppError(http.StatusConflict, "镜头、脚本或项目状态已改变，整批未覆盖；请回读后确认范围")
	}
	if errors.Is(err, repository.ErrShotRequestConflict) {
		return NewAppError(http.StatusConflict, "requestId已用于其他镜头批次，未写入")
	}
	return err
}
