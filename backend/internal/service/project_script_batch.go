package service

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type ScriptChapterInput struct {
	Title      string `json:"title"`
	SourceText string `json:"sourceText"`
}

type CreateProjectScriptBatchRequest struct {
	ExpectedProjectRevision int64                `json:"expectedProjectRevision"`
	RequestID               string               `json:"requestId"`
	Note                    string               `json:"note"`
	Chapters                []ScriptChapterInput `json:"chapters"`
}

type ProjectScriptBatchResult struct {
	Receipt   model.ProjectScriptBatch    `json:"receipt"`
	Revisions []model.ProjectUnitRevision `json:"revisions"`
	Replayed  bool                        `json:"replayed"`
}

func (s *Service) GetProjectScriptBatch(userID, projectID, requestID string) (ProjectScriptBatchResult, error) {
	if _, err := s.repo.ProjectForUser(userID, projectID); err != nil {
		return ProjectScriptBatchResult{}, err
	}
	receipt, err := s.repo.ProjectScriptBatch(projectID, requestID)
	if err != nil {
		return ProjectScriptBatchResult{}, err
	}
	return s.readScriptBatch(receipt, false)
}

func (s *Service) readScriptBatch(receipt model.ProjectScriptBatch, replayed bool) (ProjectScriptBatchResult, error) {
	result := ProjectScriptBatchResult{Receipt: receipt, Replayed: replayed, Revisions: []model.ProjectUnitRevision{}}
	for _, id := range receipt.UnitIDs {
		row, err := s.repo.ProjectUnitRevision(receipt.ProjectID, id, 1)
		if err != nil {
			return result, err
		}
		result.Revisions = append(result.Revisions, row)
	}
	return result, nil
}

func (s *Service) CreateProjectScriptBatch(userID, projectID string, req CreateProjectScriptBatchRequest) (_ ProjectScriptBatchResult, resultErr error) {
	if req.ExpectedProjectRevision < 1 || strings.TrimSpace(req.RequestID) != req.RequestID || req.RequestID == "" || len(req.RequestID) > 100 || strings.HasPrefix(req.RequestID, "baseline:") || strings.TrimSpace(req.Note) == "" || len(req.Note) > 1000 || len(req.Chapters) < 1 || len(req.Chapters) > 50 {
		return ProjectScriptBatchResult{}, BadAuthRequest("新建剧本需要项目版本、稳定请求ID、说明及1–50个章节")
	}
	size := 0
	for _, chapter := range req.Chapters {
		size += len(chapter.SourceText)
		if strings.TrimSpace(chapter.Title) == "" || len(chapter.Title) > 960 || strings.TrimSpace(chapter.SourceText) == "" || len(chapter.SourceText) > 2<<20 || size > 2<<20 {
			return ProjectScriptBatchResult{}, BadAuthRequest("章节标题或正文无效，整批正文不得超过2MiB")
		}
	}
	finish, err := s.beginProjectDirectoryWrite(userID, projectID)
	if err != nil {
		return ProjectScriptBatchResult{}, err
	}
	defer finish(&resultErr)
	project, err := s.repo.ProjectForUser(userID, projectID)
	if err != nil {
		return ProjectScriptBatchResult{}, err
	}
	if project.Status != model.ProjectStatusActive {
		return ProjectScriptBatchResult{}, NewAppError(http.StatusConflict, "项目已归档，不能新建剧本")
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return ProjectScriptBatchResult{}, err
	}
	input := repository.ScriptBatchWrite{UserID: userID, ExpectedProjectRevision: req.ExpectedProjectRevision,
		Receipt: model.ProjectScriptBatch{ID: newID(), ProjectID: projectID, RequestID: req.RequestID, RequestHash: repository.ScriptSourceHash(string(payload)), CreatedBy: userID, UnitIDs: []string{}}}
	for _, chapter := range req.Chapters {
		unit, err := newProjectUnit(projectID, CreateProjectUnitRequest{Kind: "chapter", Title: chapter.Title, SourceText: chapter.SourceText}, 0)
		if err != nil {
			return ProjectScriptBatchResult{}, err
		}
		unit.Revision = 1
		input.Units = append(input.Units, unit)
		input.Receipt.UnitIDs = append(input.Receipt.UnitIDs, unit.ID)
		input.Revisions = append(input.Revisions, model.ProjectUnitRevision{ID: newID(), ProjectID: projectID, UnitID: unit.ID, Revision: 1, Title: unit.Title, SourceText: unit.SourceText, SourceHash: repository.ScriptSourceHash(unit.SourceText), Status: unit.Status, RequestID: req.RequestID, RequestHash: input.Receipt.RequestHash, Note: req.Note, CreatedBy: userID, CreatedAt: unit.CreatedAt})
	}
	receipt, replayed, err := s.repo.CreateProjectScriptBatch(input)
	if errors.Is(err, repository.ErrScriptRevisionConflict) {
		return ProjectScriptBatchResult{}, NewAppError(http.StatusConflict, "项目版本已改变，未创建章节；请回读原请求及当前项目")
	}
	if errors.Is(err, repository.ErrScriptRequestConflict) {
		return ProjectScriptBatchResult{}, NewAppError(http.StatusConflict, "requestId已用于另一批章节，未写入")
	}
	if err != nil {
		return ProjectScriptBatchResult{}, err
	}
	return s.readScriptBatch(receipt, replayed)
}
