package service

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func (s *Service) GetProjectScriptRevisions(userID, projectID, unitID string) ([]model.ProjectUnitRevision, error) {
	unit, err := s.GetProjectUnit(userID, projectID, unitID)
	if err != nil {
		return nil, err
	}
	rows, err := s.repo.ProjectUnitRevisions(projectID, unitID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		rows = append(rows, currentScriptRevision(unit, false))
	}
	return rows, nil
}

func (s *Service) GetProjectScriptRevision(userID, projectID, unitID string, revision int64) (model.ProjectUnitRevision, error) {
	unit, err := s.GetProjectUnit(userID, projectID, unitID)
	if err != nil {
		return model.ProjectUnitRevision{}, err
	}
	row, err := s.repo.ProjectUnitRevision(projectID, unitID, revision)
	if errors.Is(err, gorm.ErrRecordNotFound) && revision == unit.Revision {
		return currentScriptRevision(unit, true), nil
	}
	return row, err
}

func currentScriptRevision(unit model.ProjectUnit, includeText bool) model.ProjectUnitRevision {
	row := model.ProjectUnitRevision{ProjectID: unit.ProjectID, UnitID: unit.ID, Revision: unit.Revision, Title: unit.Title, SourceHash: repository.ScriptSourceHash(unit.SourceText), Status: unit.Status, CreatedAt: unit.UpdatedAt}
	if includeText {
		row.SourceText = unit.SourceText
	}
	return row
}

// The creative Agent edits chapter drafts; it cannot reopen completed content
// or turn an editing request into a formal approval/lock transition.
func (s *Service) ReviseProjectScript(userID, projectID, unitID string, req UpdateProjectUnitRequest) (repository.ScriptRevisionResult, error) {
	unit, err := s.GetProjectUnit(userID, projectID, unitID)
	if err != nil {
		return repository.ScriptRevisionResult{}, err
	}
	if unit.Status != model.ProjectUnitStatusDraft && unit.Status != model.ProjectUnitStatusReady {
		return repository.ScriptRevisionResult{}, NewAppError(http.StatusConflict, "只允许修订可编辑章节，不修改已完成或锁定内容")
	}
	if req.Status != "" {
		return repository.ScriptRevisionResult{}, BadAuthRequest("剧本修订工具不能更改审批或完成状态")
	}
	return s.SaveProjectScriptRevision(userID, projectID, unitID, req)
}

func (s *Service) SaveProjectScriptRevision(userID, projectID, unitID string, req UpdateProjectUnitRequest) (repository.ScriptRevisionResult, error) {
	project, err := s.repo.ProjectForUser(userID, projectID)
	if err != nil {
		return repository.ScriptRevisionResult{}, err
	}
	if project.Status != model.ProjectStatusActive {
		return repository.ScriptRevisionResult{}, NewAppError(http.StatusConflict, "项目已归档，不能修改剧本")
	}
	unit, err := s.repo.ProjectUnit(projectID, unitID)
	if err != nil {
		return repository.ScriptRevisionResult{}, err
	}
	if req.ExpectedRevision < 1 || strings.TrimSpace(req.RequestID) == "" || len(req.RequestID) > 100 || strings.HasPrefix(req.RequestID, "baseline:") {
		return repository.ScriptRevisionResult{}, BadAuthRequest("必须提供已读取的 expectedRevision 和本次修订的 requestId")
	}
	if len(req.SourceText) > 2<<20 || len(req.Note) > 1000 || len(req.Title) > 960 {
		return repository.ScriptRevisionResult{}, BadAuthRequest("剧本或修订说明超过长度限制")
	}
	// Hash the request, not the latest chapter: an identical retry remains
	// idempotent even when the current chapter has advanced in the meantime.
	payload, err := json.Marshal(req)
	if err != nil {
		return repository.ScriptRevisionResult{}, err
	}
	if title := strings.TrimSpace(req.Title); title != "" {
		unit.Title = title
	}
	unit.SourceText = req.SourceText
	if status := model.ProjectUnitStatus(strings.TrimSpace(req.Status)); status != "" {
		if status != model.ProjectUnitStatusDraft && status != model.ProjectUnitStatusReady && status != model.ProjectUnitStatusCompleted {
			return repository.ScriptRevisionResult{}, BadAuthRequest("不支持的章节状态")
		}
		unit.Status = status
	}
	result, err := s.repo.SaveProjectUnitRevision(repository.ScriptRevisionWrite{UserID: userID, ExpectedRevision: req.ExpectedRevision, Unit: *unit, InitialID: newID(), Revision: model.ProjectUnitRevision{ID: newID(), RequestID: req.RequestID, RequestHash: repository.ScriptSourceHash(string(payload)), Note: strings.TrimSpace(req.Note)}})
	if errors.Is(err, repository.ErrScriptRevisionConflict) {
		return result, NewAppError(http.StatusConflict, "剧本版本已改变，未覆盖正文；请重新读取并确认修改范围")
	}
	if errors.Is(err, repository.ErrScriptRequestConflict) {
		return result, NewAppError(http.StatusConflict, "requestId 已用于另一份修订，未写入")
	}
	return result, err
}
