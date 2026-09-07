package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/mattn/go-sqlite3"
	"sort"
	"strings"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type CanvasPromptTargetRequest struct {
	ProjectID string `json:"projectId"`
	NodeID    string `json:"nodeId"`
	RowID     string `json:"rowId"`
	Kind      string `json:"kind"`
}

type SaveCanvasPromptRequest struct {
	CanvasPromptTargetRequest
	RequestID           string `json:"requestId"`
	ExpectedRevision    *int64 `json:"expectedRevision"`
	ExpectedContentHash string `json:"expectedContentHash"`
	DependencyHash      string `json:"dependencyHash"`
	Prompt              string `json:"prompt"`
}

type CanvasPromptDependencies struct {
	Project map[string]string `json:"project"`
	Source  struct {
		UnitID   string `json:"unitId"`
		Title    string `json:"title"`
		Revision int64  `json:"revision"`
		Hash     string `json:"hash"`
	} `json:"source"`
	Shot      model.Shot                 `json:"shot"`
	Direction map[string]json.RawMessage `json:"direction"`
	Assets    []CanvasPromptAsset        `json:"assets"`
	Guidance  CanvasPromptGuidance       `json:"guidance"`
}

type CanvasPromptGuidance struct {
	Operation            string `json:"operation"`
	Content              string `json:"content"`
	TemplateID           string `json:"templateId"`
	TemplateVersion      int    `json:"templateVersion"`
	CustomizationID      string `json:"customizationId"`
	CustomizationUpdated string `json:"customizationUpdated"`
}

type CanvasPromptAsset struct {
	Origin         string                     `json:"origin"`
	Role           string                     `json:"role"`
	BindingStatus  string                     `json:"bindingStatus,omitempty"`
	NodeID         string                     `json:"nodeId,omitempty"`
	NodeType       string                     `json:"nodeType,omitempty"`
	Title          string                     `json:"title,omitempty"`
	NodeFacts      map[string]json.RawMessage `json:"nodeFacts,omitempty"`
	AssetID        string                     `json:"assetId,omitempty"`
	Version        *model.AssetVersion        `json:"version,omitempty"`
	Resource       map[string]any             `json:"resource,omitempty"`
	VisualVerified bool                       `json:"visualVerified"`
}

type CanvasPromptContext struct {
	CanvasID string `json:"canvasId"`
	CanvasPromptTargetRequest
	WriteToken      string                   `json:"writeToken"`
	CanvasUpdatedAt string                   `json:"canvasUpdatedAt"`
	Prompt          string                   `json:"prompt"`
	State           model.CanvasPromptState  `json:"state"`
	Managed         bool                     `json:"managed"`
	Dependencies    CanvasPromptDependencies `json:"dependencies"`
	DependencyHash  string                   `json:"dependencyHash"`
	Stale           bool                     `json:"stale"`
	WriteBlockers   []string                 `json:"writeBlockers"`
	LocalOverrides  []string                 `json:"localOverrides"`
}

type CanvasPromptSaveResult struct {
	Receipt  model.CanvasPromptReceipt `json:"receipt"`
	Replayed bool                      `json:"replayed"`
}

type CanvasPromptRevisionSummary struct {
	Revision       int64     `json:"revision"`
	ContentHash    string    `json:"contentHash"`
	DependencyHash string    `json:"dependencyHash"`
	RequestID      string    `json:"requestId"`
	CreatedAt      time.Time `json:"createdAt"`
}

// Historical reads require canvas ownership, not still-existing source assets.
// A removed upstream reference must not prevent recovery of the saved draft.
func (s *Service) GetCanvasPromptHistory(userID, canvasID, nodeID, rowID, kind string) ([]CanvasPromptRevisionSummary, error) {
	if _, err := s.repo.CanvasProjectForUser(userID, canvasID); err != nil {
		return nil, canvasPromptError(err)
	}
	if _, err := model.CanvasPromptField(kind); err != nil || nodeID == "" || rowID == "" {
		return nil, BadAuthRequest("提示词历史定位无效")
	}
	rows, err := s.repo.CanvasPromptRevisionSummaries(userID, canvasID, nodeID, rowID, kind)
	if err != nil {
		return nil, canvasPromptError(err)
	}
	result := make([]CanvasPromptRevisionSummary, 0, len(rows))
	for _, row := range rows {
		result = append(result, CanvasPromptRevisionSummary{row.Revision, row.ContentHash, row.DependencyHash, row.RequestID, row.CreatedAt})
	}
	return result, nil
}

func (s *Service) GetCanvasPromptRevision(userID, canvasID, nodeID, rowID, kind string, revision int64) (model.CanvasPromptRevision, error) {
	if _, err := s.repo.CanvasProjectForUser(userID, canvasID); err != nil {
		return model.CanvasPromptRevision{}, canvasPromptError(err)
	}
	if _, err := model.CanvasPromptField(kind); err != nil || nodeID == "" || rowID == "" || revision < 0 {
		return model.CanvasPromptRevision{}, BadAuthRequest("提示词修订定位无效")
	}
	row, err := s.repo.CanvasPromptRevision(userID, canvasID, nodeID, rowID, kind, revision)
	return row, canvasPromptError(err)
}

func (s *Service) GetCanvasPromptReceipt(userID, canvasID, requestID string) (model.CanvasPromptReceipt, error) {
	if _, err := s.repo.CanvasProjectForUser(userID, canvasID); err != nil {
		return model.CanvasPromptReceipt{}, canvasPromptError(err)
	}
	row, err := s.repo.CanvasPromptReceipt(userID, canvasID, requestID)
	return row, canvasPromptError(err)
}

func (s *Service) GetCanvasPrompt(userID, canvasID string, req CanvasPromptTargetRequest) (CanvasPromptContext, error) {
	var context CanvasPromptContext
	err := s.repo.ReadCanvasPrompt(userID, canvasID, func(tx *repository.Repository, canvas model.CanvasProject) error {
		var err error
		context, _, err = canvasPromptContext(tx, userID, canvas, req)
		return err
	})
	return context, canvasPromptError(err)
}

func canvasPromptContext(repo *repository.Repository, userID string, canvas model.CanvasProject, req CanvasPromptTargetRequest) (CanvasPromptContext, *model.CanvasPromptTarget, error) {
	context := CanvasPromptContext{CanvasID: canvas.ID, CanvasPromptTargetRequest: req, WriteBlockers: []string{}, LocalOverrides: []string{}}
	field, err := model.CanvasPromptField(req.Kind)
	if err != nil || req.ProjectID == "" || req.NodeID == "" || req.RowID == "" {
		return context, nil, BadAuthRequest("必须指定项目、分镜节点、镜头行和提示词类型")
	}
	if canvas.ProjectID != req.ProjectID {
		return context, nil, model.ErrCanvasPromptConflict
	}
	project, err := repo.ProjectForUser(userID, req.ProjectID)
	if err != nil {
		return context, nil, err
	}
	doc, err := model.ParseCanvasPromptDocument([]byte(canvas.PayloadJSON))
	if err != nil {
		return context, nil, err
	}
	if model.CanvasJSONText(doc.Root, "projectId") != req.ProjectID {
		return context, nil, model.ErrCanvasPromptConflict
	}
	target, err := doc.Target(req.NodeID, req.RowID)
	if err != nil {
		return context, nil, BadAuthRequest("指定分镜行不存在或身份不唯一")
	}
	var projection struct {
		ID             string                     `json:"id"`
		Revision       int64                      `json:"revision"`
		SourceRevision int64                      `json:"sourceRevision"`
		SourceHash     string                     `json:"sourceHash"`
		MappedFields   map[string]json.RawMessage `json:"mappedFields"`
	}
	if json.Unmarshal(target.Row["projectShotSource"], &projection) != nil || projection.ID == "" || req.RowID != "project-shot:"+projection.ID {
		return context, nil, BadAuthRequest("提示词必须绑定已保存的业务镜头，不能猜测镜头 ID")
	}
	unitID := model.CanvasJSONText(target.Metadata, "chapterId")
	if _, err := repo.CanvasUnitLink(req.ProjectID, canvas.ID, unitID); err != nil {
		return context, nil, err
	}
	unit, err := repo.ProjectUnit(req.ProjectID, unitID)
	if err != nil {
		return context, nil, err
	}
	shot, err := repo.ShotForProject(req.ProjectID, projection.ID)
	if err != nil {
		return context, nil, err
	}
	if shot.UnitID != unitID {
		return context, nil, model.ErrCanvasPromptConflict
	}
	if project.Status != model.ProjectStatusActive || (unit.Status != model.ProjectUnitStatusDraft && unit.Status != model.ProjectUnitStatusReady) || shot.Status == "completed" {
		context.WriteBlockers = append(context.WriteBlockers, "SOURCE_NOT_EDITABLE")
	}
	deps := CanvasPromptDependencies{Project: map[string]string{"id": project.ID, "name": project.Name, "description": project.Description, "aspectRatio": project.AspectRatio, "stylePresetId": project.StylePresetID, "styleProfileJson": project.StyleProfileJSON}, Shot: *shot, Direction: map[string]json.RawMessage{}, Assets: []CanvasPromptAsset{}}
	deps.Source.UnitID, deps.Source.Title, deps.Source.Revision, deps.Source.Hash = unit.ID, unit.Title, unit.Revision, repository.ScriptSourceHash(unit.SourceText)
	if shot.SourceRevision != unit.Revision || shot.SourceHash != deps.Source.Hash {
		context.WriteBlockers = append(context.WriteBlockers, "SHOT_SOURCE_STALE")
	}
	if projection.Revision != shot.Revision || projection.SourceRevision != shot.SourceRevision || projection.SourceHash != shot.SourceHash {
		context.WriteBlockers = append(context.WriteBlockers, "CANVAS_SHOT_STALE")
	}
	for _, key := range []string{"shotNumber", "durationSeconds", "plotDescription", "dialogue", "characters", "narrativeIntent", "viewerPOV", "performanceBlocking", "shotSize", "emotion", "lightingAndAtmosphere", "audioEffects", "camera", "motion", "timeBeats", "mustHave", "optionalDetails", "continuityOut", "negativePrompt", "assetBindings"} {
		if value, ok := target.Row[key]; ok {
			deps.Direction[key] = value
		}
	}
	if req.Kind == "video" {
		if value, ok := target.Row["imageNodeId"]; ok {
			deps.Direction["imageNodeId"] = value
		}
	}
	// Native director edits remain intentional local overrides. Expose both the
	// business shot and effective row facts; never silently replace either one.
	for key, baseline := range projection.MappedFields {
		if string(target.Row[key]) != string(baseline) {
			context.LocalOverrides = append(context.LocalOverrides, key)
		}
	}
	sort.Strings(context.LocalOverrides)
	if err := canvasPromptAssets(repo, userID, req.ProjectID, target, shot.ID, req.Kind, &deps.Assets); err != nil {
		return context, nil, err
	}
	deps.Guidance, err = canvasPromptGuidance(repo, userID, req.Kind, target.Row, deps.Project)
	if err != nil {
		return context, nil, err
	}
	context.Prompt = model.CanvasJSONText(target.Row, field)
	if raw, ok := target.Row[field]; ok && json.Unmarshal(raw, &context.Prompt) != nil {
		return context, nil, BadAuthRequest("提示词正文不是文本，已保留原值")
	}
	context.WriteToken = model.CanvasJSONText(doc.Root, "promptWriteToken")
	context.CanvasUpdatedAt = model.CanvasJSONText(doc.Root, "updatedAt")
	context.State, context.Managed, err = target.State(req.Kind)
	if err != nil {
		return context, nil, err
	}
	hash := repository.ScriptSourceHash(context.Prompt)
	if context.Managed && context.State.ContentHash != hash {
		return context, nil, model.ErrCanvasPromptConflict
	}
	if !context.Managed {
		context.State.ContentHash = hash
	}
	context.Dependencies = deps
	encoded, err := json.Marshal(deps)
	if err != nil {
		return context, nil, err
	}
	context.DependencyHash = repository.ScriptSourceHash(string(encoded))
	context.Stale = context.Managed && context.State.DependencyHash != context.DependencyHash
	return context, target, nil
}

func canvasPromptGuidance(repo *repository.Repository, userID, kind string, row map[string]json.RawMessage, project map[string]string) (CanvasPromptGuidance, error) {
	value := func(key string) string { return model.CanvasJSONText(row, key) }
	operation := promptOperationStoryboardFirstFrame
	if kind == "video" {
		operation = promptOperationStoryboardVideo
	}
	// Reuse the native template/customization compiler inside the same repository
	// snapshot. Its compact generation helpers truncate dialogue; creative source
	// guidance must instead retain the full mapped text and leave adaptation later.
	values := map[string]string{
		"项目视觉":   strings.Join([]string{project["stylePresetId"], project["styleProfileJson"]}, "\n"),
		"首帧构图":   value("plotDescription") + "\n" + value("camera") + "\n" + value("lightingAndAtmosphere"),
		"表演起始状态": value("performanceBlocking"),
		"负面要求":   value("negativePrompt"),
		"镜头意图":   value("narrativeIntent") + "\n" + value("viewerPOV") + "\n" + value("emotion"),
		"表演与调度":  value("performanceBlocking"),
		"摄影机":    value("shotSize") + "\n" + value("camera") + "\n" + value("motion"),
		"时间节拍":   value("timeBeats"),
		"运动与结尾":  value("motion") + "\n" + value("continuityOut"),
		"声音":     value("dialogue") + "\n" + value("audioEffects"),
		"执行优先级":  string(row["mustHave"]),
	}
	compiled, err := (&Service{repo: repo}).compilePrompt(userID, operation, values)
	if err != nil {
		return CanvasPromptGuidance{}, err
	}
	return CanvasPromptGuidance{Operation: operation, Content: compiled.Content, TemplateID: compiled.TemplateID, TemplateVersion: compiled.TemplateVersion, CustomizationID: compiled.CustomizationID, CustomizationUpdated: compiled.CustomizationUpdated}, nil
}

func canvasPromptAssets(repo *repository.Repository, userID, projectID string, target *model.CanvasPromptTarget, shotID, kind string, result *[]CanvasPromptAsset) error {
	resolveVersion := func(item *CanvasPromptAsset, assetID, versionID string) error {
		if assetID == "" && versionID == "" {
			return nil
		}
		if assetID == "" {
			return BadAuthRequest("素材版本缺少素材归属")
		}
		asset, err := repo.AssetForUser(userID, assetID)
		if err != nil {
			return err
		}
		if _, err := repo.ProjectAssetLink(projectID, assetID); err != nil {
			return err
		}
		if versionID == "" {
			versionID = asset.PrimaryVersionID
		}
		if versionID == "" {
			return BadAuthRequest("绑定素材没有可读取版本，不能声称已绑定设定")
		}
		version, err := repo.AssetVersionForProject(projectID, versionID)
		if err != nil {
			return err
		}
		if version.AssetID != assetID {
			return model.ErrCanvasPromptConflict
		}
		item.AssetID, item.Version = assetID, version
		return nil
	}
	refs, err := repo.ProjectShotAssetReferences(projectID)
	if err != nil {
		return err
	}
	sort.Slice(refs, func(i, j int) bool { return refs[i].ID < refs[j].ID })
	for _, ref := range refs {
		if ref.ShotID != shotID {
			continue
		}
		version, err := repo.AssetVersionForProject(projectID, ref.AssetVersionID)
		if err != nil {
			return err
		}
		item := CanvasPromptAsset{Origin: "shot:" + ref.ID, Role: ref.Role, BindingStatus: ref.Status}
		if err := resolveVersion(&item, version.AssetID, ref.AssetVersionID); err != nil {
			return err
		}
		*result = append(*result, item)
	}
	var characters []struct {
		AssetID   string `json:"characterAssetId"`
		VersionID string `json:"characterVersionId"`
	}
	if raw, ok := target.Row["characters"]; ok && json.Unmarshal(raw, &characters) != nil {
		return BadAuthRequest("角色绑定格式无效")
	}
	type nodeBinding struct {
		NodeID   string `json:"nodeId"`
		Role     string `json:"role"`
		Priority int    `json:"priority"`
	}
	var bindings []nodeBinding
	if raw, ok := target.Row["assetBindings"]; ok && json.Unmarshal(raw, &bindings) != nil {
		return BadAuthRequest("素材绑定格式无效")
	}
	for index, character := range characters {
		item := CanvasPromptAsset{Origin: fmt.Sprintf("character:%d", index), Role: "character"}
		if err := resolveVersion(&item, character.AssetID, character.VersionID); err != nil {
			return err
		}
		if item.Version != nil {
			*result = append(*result, item)
		}
	}
	// Follow the existing storyboardRowReferenceNodeIds inputs: global references,
	// character nodes, incoming row/target links, and the video first frame.
	var globalRefs []string
	if raw, ok := target.Storyboard["referenceNodeIds"]; ok && json.Unmarshal(raw, &globalRefs) != nil {
		return BadAuthRequest("全局参考节点格式无效")
	}
	rowBindings := bindings
	bindings = make([]nodeBinding, 0, len(globalRefs)+len(rowBindings))
	for _, id := range globalRefs {
		bindings = append(bindings, nodeBinding{NodeID: id, Role: "reference"})
	}
	bindings = append(bindings, rowBindings...)
	for _, node := range target.Document.Nodes {
		var metadata map[string]json.RawMessage
		if json.Unmarshal(node["metadata"], &metadata) != nil {
			continue
		}
		if model.CanvasJSONText(metadata, "workflowKind") != "character" {
			continue
		}
		for _, character := range characters {
			if character.AssetID != "" && model.CanvasJSONText(metadata, "characterAssetId") == character.AssetID {
				bindings = append(bindings, nodeBinding{NodeID: model.CanvasJSONText(node, "id"), Role: "character"})
				break
			}
		}
	}
	targetID := model.CanvasJSONText(target.Row, "imageNodeId")
	if kind == "video" {
		targetID = model.CanvasJSONText(target.Row, "videoNodeId")
	}
	var connections []struct {
		From     string `json:"fromNodeId"`
		To       string `json:"toNodeId"`
		Handle   string `json:"toHandleId"`
		Relation string `json:"relation"`
	}
	if raw, ok := target.Document.Root["connections"]; ok && json.Unmarshal(raw, &connections) != nil {
		return BadAuthRequest("画布参考连线格式无效")
	}
	for _, connection := range connections {
		if connection.To == model.CanvasJSONText(target.Node, "id") && connection.Handle == "row:"+model.CanvasJSONText(target.Row, "id") {
			bindings = append(bindings, nodeBinding{NodeID: connection.From, Role: "reference"})
		}
	}
	for _, connection := range connections {
		if targetID != "" && connection.To == targetID && connection.Relation == "" {
			bindings = append(bindings, nodeBinding{NodeID: connection.From, Role: "reference"})
		}
	}
	imageID := model.CanvasJSONText(target.Row, "imageNodeId")
	if kind == "video" && imageID != "" {
		bindings = append(bindings, nodeBinding{NodeID: imageID, Role: "first-frame"})
	}
	seenNodes := map[string]bool{}
	for index, binding := range bindings {
		if binding.NodeID == model.CanvasJSONText(target.Node, "id") || (kind == "image" && binding.NodeID == imageID) || seenNodes[binding.NodeID] {
			continue
		}
		seenNodes[binding.NodeID] = true
		if kind == "video" && binding.NodeID == imageID {
			binding.Role = "first-frame"
		}
		var node map[string]json.RawMessage
		for _, item := range target.Document.Nodes {
			if model.CanvasJSONText(item, "id") == binding.NodeID {
				node = item
				break
			}
		}
		if node == nil {
			return BadAuthRequest("绑定的素材节点已不存在")
		}
		var metadata map[string]json.RawMessage
		if raw, ok := node["metadata"]; ok && json.Unmarshal(raw, &metadata) != nil {
			return BadAuthRequest("素材节点数据无效")
		}
		item := CanvasPromptAsset{Origin: fmt.Sprintf("node:%d", index), NodeID: binding.NodeID, NodeType: model.CanvasJSONText(node, "type"), Role: binding.Role, Title: model.CanvasJSONText(node, "title"), NodeFacts: map[string]json.RawMessage{}}
		for _, key := range []string{"content", "prompt", "characterName", "characterPrompt", "characterDefinition", "assetCategory", "stylePresetId", "styleProfileJson", "sceneId", "storageKey"} {
			if value, ok := metadata[key]; ok {
				item.NodeFacts[key] = value
			}
		}
		assetID := model.CanvasJSONText(metadata, "characterAssetId")
		if assetID == "" {
			assetID = model.CanvasJSONText(metadata, "assetId")
		}
		if err := resolveVersion(&item, assetID, model.CanvasJSONText(metadata, "characterVersionId")); err != nil {
			return err
		}
		if storageKey := model.CanvasJSONText(metadata, "storageKey"); storageKey != "" {
			if !strings.HasPrefix(storageKey, "resource:") {
				return BadAuthRequest("素材尚未同步到当前用户资源库，不能建立可回读绑定")
			}
			resource, err := repo.ResourceForUser(userID, strings.TrimPrefix(storageKey, "resource:"))
			if err != nil {
				return err
			}
			if resource.Status != model.ResourceStatusReady {
				return BadAuthRequest("参考资源未就绪，不能声称已绑定可用素材")
			}
			item.Resource = map[string]any{"id": resource.ID, "mimeType": resource.MimeType, "size": resource.Size, "etag": resource.ETag, "updatedAt": resource.UpdatedAt}
		}
		*result = append(*result, item)
	}
	return nil
}

func (s *Service) SaveCanvasPrompt(userID, canvasID string, req SaveCanvasPromptRequest) (_ CanvasPromptSaveResult, resultErr error) {
	finish, err := s.beginProjectDirectoryWrite(userID, req.ProjectID)
	if err != nil {
		return CanvasPromptSaveResult{}, err
	}
	defer finish(&resultErr)
	result := CanvasPromptSaveResult{}
	if strings.TrimSpace(req.RequestID) != req.RequestID || req.RequestID == "" || len(req.RequestID) > 100 || req.ExpectedRevision == nil || *req.ExpectedRevision < 0 || len(req.Prompt) > 64<<10 || strings.TrimSpace(req.Prompt) == "" || len(req.ExpectedContentHash) != 64 || len(req.DependencyHash) != 64 {
		return result, BadAuthRequest("提示词保存需要 requestId、当前版本/哈希、依赖哈希和 1–64 KiB 正文")
	}
	requestBytes, err := json.Marshal(req)
	if err != nil {
		return result, err
	}
	requestHash := repository.ScriptSourceHash(string(requestBytes))
	policy, err := s.RuntimePolicy()
	if err != nil {
		return result, err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	err = s.repo.ChangeCanvasPrompt(userID, canvasID, func(tx *repository.Repository, canvas model.CanvasProject) (string, error) {
		if canvas.ProjectID != req.ProjectID {
			return "", model.ErrCanvasPromptConflict
		}
		receipt, err := tx.CanvasPromptReceipt(userID, canvasID, req.RequestID)
		if err == nil {
			if receipt.RequestHash != requestHash {
				return "", model.ErrCanvasPromptConflict
			}
			result = CanvasPromptSaveResult{Receipt: receipt, Replayed: true}
			return canvas.PayloadJSON, nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return "", err
		}
		context, target, err := canvasPromptContext(tx, userID, canvas, req.CanvasPromptTargetRequest)
		if err != nil {
			return "", err
		}
		if len(context.WriteBlockers) > 0 || context.State.Revision != *req.ExpectedRevision || context.State.ContentHash != req.ExpectedContentHash || context.DependencyHash != req.DependencyHash {
			return "", model.ErrCanvasPromptConflict
		}
		now := time.Now().UTC()
		target.Document.Root["updatedAt"], _ = json.Marshal(now)
		dependencies, err := json.Marshal(context.Dependencies)
		if err != nil {
			return "", err
		}
		if len(dependencies) > 1<<20 {
			return "", BadAuthRequest("提示词依赖超过 1 MiB，请缩小素材绑定范围")
		}
		next := model.CanvasPromptRevision{ID: newID(), UserID: userID, CanvasID: canvasID, NodeID: req.NodeID, RowID: req.RowID, Kind: req.Kind, Revision: context.State.Revision + 1, Prompt: req.Prompt, ContentHash: repository.ScriptSourceHash(req.Prompt), DependencyHash: context.DependencyHash, Dependencies: dependencies, RequestID: req.RequestID, CreatedAt: now}
		raw, err := target.SetPrompt(req.Kind, req.Prompt, model.CanvasPromptState{Revision: next.Revision, ContentHash: next.ContentHash, DependencyHash: next.DependencyHash})
		if err != nil {
			return "", err
		}
		if err := validateSyncedPayload(raw, "画布"); err != nil {
			return "", err
		}
		usage, err := tx.UserStorageUsage(userID)
		if err != nil {
			return "", err
		}
		if err := validateStructuredStorageQuotaWithPolicy(usage, "canvas", false, int64(len(raw)-len(canvas.PayloadJSON)), policy.Resource); err != nil {
			return "", err
		}
		if !context.Managed {
			baseline := next
			baseline.ID, baseline.Revision, baseline.Prompt, baseline.ContentHash = newID(), 0, context.Prompt, context.State.ContentHash
			// A legacy prompt has no proven creation dependencies. Do not invent them.
			baseline.DependencyHash, baseline.Dependencies, baseline.RequestID = "", json.RawMessage(`null`), "baseline"
			if err := tx.AppendCanvasPromptRevision(baseline, true); err != nil {
				return "", err
			}
		}
		if err := tx.AppendCanvasPromptRevision(next, false); err != nil {
			return "", err
		}
		receipt = model.CanvasPromptReceipt{ID: newID(), UserID: userID, CanvasID: canvasID, RequestID: req.RequestID, RequestHash: requestHash, Snapshot: next, CreatedAt: now}
		if err := tx.AppendCanvasPromptReceipt(receipt); err != nil {
			return "", err
		}
		// Re-read database timestamps/serialization, never substitute a planned write.
		result.Receipt, err = tx.CanvasPromptReceipt(userID, canvasID, req.RequestID)
		return string(raw), err
	})
	if err != nil {
		return CanvasPromptSaveResult{}, canvasPromptError(err)
	}
	return result, nil
}

func canvasPromptError(err error) error {
	var sqliteErr sqlite3.Error
	var postgresErr interface{ SQLState() string }
	if (errors.As(err, &sqliteErr) && (sqliteErr.Code == sqlite3.ErrBusy || sqliteErr.Code == sqlite3.ErrLocked)) || (errors.As(err, &postgresErr) && (postgresErr.SQLState() == "40001" || postgresErr.SQLState() == "40P01")) {
		return WrapAppError(409, "保存期间存在并发修改，本次未覆盖；请先回读原 requestId，不要盲建新请求", err)
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return NewAppError(404, "画布、业务来源、绑定素材或提示词回执不存在")
	}
	if errors.Is(err, model.ErrCanvasPromptConflict) {
		return WrapAppError(409, "提示词、镜头来源或依赖已改变，本次未覆盖；请回读后确认修改范围", err)
	}
	return err
}
