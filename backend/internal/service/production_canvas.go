package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const productionCanvasRole = "production"

const productionCanvasWriteEnv = "CANVAS_FILM_PRODUCTION_CANVAS_WRITE_ENABLED"

type AcquireProductionCanvasRequest struct {
	HumanConfirmed      bool   `json:"humanConfirmed"`
	ConfirmationID      string `json:"confirmationId"`
	ExpectedRevision    int64  `json:"expectedRevision"`
	ExpectedContentHash string `json:"expectedContentHash"`
}

type ProductionCanvasResult struct {
	Canvas              model.CanvasProject  `json:"canvas"`
	Link                model.CanvasUnitLink `json:"link"`
	Disposition         string               `json:"disposition"`
	ProjectRevision     int64                `json:"projectRevision"`
	ObservedContentHash string               `json:"observedContentHash"`
	AuditEventID        string               `json:"auditEventId"`
	ConfirmationID      string               `json:"confirmationId"`
	ConfirmedByUserID   string               `json:"confirmedByUserId"`
	ConfirmedAt         time.Time            `json:"confirmedAt"`
}

type productionCanvasDocument struct {
	ID             string             `json:"id"`
	ProjectID      string             `json:"projectId"`
	Title          string             `json:"title"`
	CreatedAt      string             `json:"createdAt"`
	UpdatedAt      string             `json:"updatedAt"`
	Nodes          []any              `json:"nodes"`
	Connections    []any              `json:"connections"`
	ChatSessions   []any              `json:"chatSessions"`
	ActiveChatID   *string            `json:"activeChatId"`
	BackgroundMode string             `json:"backgroundMode"`
	ShowImageInfo  bool               `json:"showImageInfo"`
	Viewport       map[string]float64 `json:"viewport"`
	DirectorScenes []any              `json:"directorScenes"`
}

func (s *Service) AcquireProductionCanvas(userID string, projectID string, unitID string, req AcquireProductionCanvasRequest) (ProductionCanvasResult, error) {
	if !productionCanvasWriteEnabledFromEnvironment() {
		return ProductionCanvasResult{}, NewAppError(http.StatusForbidden, "Production Canvas 正式写入开关未开启")
	}
	if !req.HumanConfirmed {
		return ProductionCanvasResult{}, BadAuthRequest("正式创建 Production Canvas 需要 Human 显式确认")
	}
	confirmationID := strings.TrimSpace(req.ConfirmationID)
	if len(confirmationID) < 8 || len(confirmationID) > 128 || !isSafeConfirmationID(confirmationID) {
		return ProductionCanvasResult{}, BadAuthRequest("confirmationId 必须是 8-128 位字母、数字、点、下划线或连字符")
	}
	projectID = strings.TrimSpace(projectID)
	unitID = strings.TrimSpace(unitID)
	if projectID == "" || unitID == "" || req.ExpectedRevision < 0 {
		return ProductionCanvasResult{}, BadAuthRequest("项目、单元或 expectedRevision 无效")
	}
	s.productionCanvasMu.Lock()
	defer s.productionCanvasMu.Unlock()
	project, err := s.repo.ProjectForUser(userID, projectID)
	if err != nil {
		return ProductionCanvasResult{}, err
	}
	if project.Status == model.ProjectStatusArchived {
		return ProductionCanvasResult{}, NewAppError(http.StatusConflict, "项目已归档，不能创建 Production Canvas")
	}
	unit, err := s.repo.ProjectUnit(projectID, unitID)
	if err != nil {
		return ProductionCanvasResult{}, err
	}
	currentHash := hostUnitSourceHash(unit.SourceText)
	if !isLowerSHA256(req.ExpectedContentHash) {
		return ProductionCanvasResult{}, BadAuthRequest("expectedContentHash 必须是小写 SHA-256")
	}
	if req.ExpectedContentHash != currentHash {
		return ProductionCanvasResult{}, NewAppError(http.StatusConflict, "ContentUnit 正文已变更，expectedContentHash 与当前 SourceText 不一致")
	}
	now := time.Now().UTC()
	canvasID := newID()
	linkID := newID()
	document := productionCanvasDocument{
		ID: canvasID, ProjectID: projectID, Title: unit.Title + " · 生产画布", CreatedAt: now.Format(time.RFC3339Nano), UpdatedAt: now.Format(time.RFC3339Nano),
		Nodes: []any{}, Connections: []any{}, ChatSessions: []any{}, ActiveChatID: nil, BackgroundMode: "dots", ShowImageInfo: true,
		Viewport: map[string]float64{"x": 0, "y": 0, "k": 1}, DirectorScenes: []any{},
	}
	payload, err := json.Marshal(document)
	if err != nil {
		return ProductionCanvasResult{}, err
	}
	canvas := model.CanvasProject{ID: canvasID, UserID: userID, ProjectID: projectID, Title: document.Title, PayloadJSON: string(payload), CreatedAt: now, UpdatedAt: now}
	auditEvent, err := newAdminAuditEvent(&model.User{ID: userID}, "production_canvas.acquire", "production_canvas", canvasID, "Human 确认取得或创建默认 Production Canvas", map[string]any{
		"confirmationId": confirmationID, "projectId": projectID, "unitId": unitID, "canvasId": canvasID, "linkId": linkID,
		"expectedProjectRevision": req.ExpectedRevision, "resultingProjectRevision": req.ExpectedRevision + 1, "observedSourceHash": currentHash,
	})
	if err != nil {
		return ProductionCanvasResult{}, err
	}
	auditEvent.CreatedAt = now
	link := model.CanvasUnitLink{ID: linkID, ProjectID: projectID, CanvasID: canvasID, UnitID: unitID, Role: productionCanvasRole, CreatedAt: now}
	guard := model.ProductionCanvasGuard{ID: newID(), ProjectID: projectID, UnitID: unitID, CanvasID: canvasID, LinkID: linkID, ConfirmationID: confirmationID, ConfirmedByUserID: userID, ObservedSourceHash: currentHash, AuditEventID: auditEvent.ID, CreatedAt: now}
	acquired, err := s.repo.AcquireProductionCanvas(repository.ProductionCanvasAcquireInput{
		UserID: userID, ProjectID: projectID, UnitID: unitID, ExpectedRevision: req.ExpectedRevision, ExpectedContentHash: currentHash, Canvas: canvas, Link: link, Guard: guard, AuditEvent: *auditEvent,
	})
	if err != nil {
		switch {
		case errors.Is(err, repository.ErrProductionCanvasConflict):
			message := "ContentUnit 存在重复或损坏的 production 关联，已停止写入"
			var conflict *repository.ProductionCanvasConflictError
			if errors.As(err, &conflict) && len(conflict.CanvasIDs) > 0 {
				message += "：" + strings.Join(conflict.CanvasIDs, " · ")
			}
			return ProductionCanvasResult{}, NewAppError(http.StatusConflict, message)
		case errors.Is(err, repository.ErrProductionCanvasRevisionConflict):
			return ProductionCanvasResult{}, NewAppError(http.StatusConflict, "Project revision 已变更，请刷新后重试")
		case errors.Is(err, repository.ErrProductionCanvasContentHashConflict):
			return ProductionCanvasResult{}, NewAppError(http.StatusConflict, "ContentUnit 正文在确认期间已变更，未创建 Production Canvas")
		default:
			return ProductionCanvasResult{}, err
		}
	}

	disposition := "reused"
	if acquired.Created {
		disposition = "created"
	}
	return ProductionCanvasResult{
		Canvas: acquired.Canvas, Link: acquired.Link, Disposition: disposition, ProjectRevision: acquired.ProjectRevision, ObservedContentHash: currentHash,
		AuditEventID: acquired.Guard.AuditEventID, ConfirmationID: acquired.Guard.ConfirmationID, ConfirmedByUserID: acquired.Guard.ConfirmedByUserID, ConfirmedAt: acquired.Guard.CreatedAt,
	}, nil
}

func productionCanvasWriteEnabledFromEnvironment() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv(productionCanvasWriteEnv)), "true")
}

func hostUnitSourceHash(sourceText string) string {
	digest := sha256.Sum256([]byte(sourceText))
	return hex.EncodeToString(digest[:])
}

func isLowerSHA256(value string) bool {
	if len(value) != 64 || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func isSafeConfirmationID(value string) bool {
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_' || char == '.' {
			continue
		}
		return false
	}
	return true
}
