package service

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func promptTestService(t *testing.T) (*Service, *gorm.DB, CanvasPromptTargetRequest) {
	t.Helper()
	s, db := shotTestService(t)
	if err := db.AutoMigrate(database.Models()...); err != nil {
		t.Fatal(err)
	}
	batch, err := s.SaveProjectUnitShots("u", "p", "chapter", shotTestRequest())
	if err != nil {
		t.Fatal(err)
	}
	shot := batch.Receipt.Shots[0]
	mapped := map[string]any{"durationSeconds": float64(shot.DurationMs) / 1000, "plotDescription": shot.Description, "dialogue": "林夏：我陪你。", "performanceBlocking": shot.Content.Action, "camera": shot.Content.Camera}
	row := map[string]any{"id": "project-shot:" + shot.ID, "projectShotSource": map[string]any{"id": shot.ID, "revision": shot.Revision, "sourceRevision": shot.SourceRevision, "sourceHash": shot.SourceHash, "mappedFields": mapped}, "imageGenerationPrompt": "**原图词**，完整保留。", "videoMotionPrompt": "旧视频词", "characters": []any{map[string]any{"characterName": "林夏"}}, "assetBindings": []any{}}
	for key, value := range mapped {
		row[key] = value
	}
	raw, _ := json.Marshal(map[string]any{"id": "c", "projectId": "p", "nodes": []any{map[string]any{"id": "n", "type": "script", "position": map[string]any{"x": 7}, "metadata": map[string]any{"chapterId": "chapter", "storyboard": map[string]any{"rows": []any{row, map[string]any{"id": "other", "imageGenerationPrompt": "旁行不变"}}}}}}})
	if err := s.repo.UpsertCanvasProject(&model.CanvasProject{ID: "c", UserID: "u", ProjectID: "p", PayloadJSON: string(raw)}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.CanvasUnitLink{ID: "link", ProjectID: "p", CanvasID: "c", UnitID: "chapter", Role: "reference"}).Error; err != nil {
		t.Fatal(err)
	}
	return s, db, CanvasPromptTargetRequest{ProjectID: "p", NodeID: "n", RowID: "project-shot:" + shot.ID, Kind: "image"}
}

func promptSaveRequest(t *testing.T, s *Service, target CanvasPromptTargetRequest, id string) SaveCanvasPromptRequest {
	t.Helper()
	context, err := s.GetCanvasPrompt("u", "c", target)
	if err != nil {
		t.Fatal(err)
	}
	return SaveCanvasPromptRequest{CanvasPromptTargetRequest: target, RequestID: id, ExpectedRevision: &context.State.Revision, ExpectedContentHash: context.State.ContentHash, DependencyHash: context.DependencyHash, Prompt: "测试正文 " + id}
}

func promptCounts(t *testing.T, db *gorm.DB, history, receipts int64) {
	t.Helper()
	for _, test := range []struct {
		row  any
		want int64
	}{{&model.CanvasPromptRevision{}, history}, {&model.CanvasPromptReceipt{}, receipts}} {
		var count int64
		if err := db.Model(test.row).Count(&count).Error; err != nil || count != test.want {
			t.Fatalf("prompt table count=%d want=%d err=%v", count, test.want, err)
		}
	}
}

func TestCanvasPromptNativeTemplateAndCustomizationAreBoundWithoutTruncation(t *testing.T) {
	s, db, target := promptTestService(t)
	if err := s.EnsureDefaultPromptTemplates(); err != nil {
		t.Fatal(err)
	}
	longDialogue := strings.Repeat("林夏：这是需要完整保留的长对白。", 100)
	dialogueJSON, _ := json.Marshal(longDialogue)
	guide, err := canvasPromptGuidance(s.repo, "u", "video", map[string]json.RawMessage{"dialogue": dialogueJSON}, map[string]string{})
	if err != nil || !strings.Contains(guide.Content, longDialogue) || guide.Operation != promptOperationStoryboardVideo || guide.TemplateID == "" {
		t.Fatalf("native full-text template not reused: %+v %v", guide, err)
	}
	req := promptSaveRequest(t, s, target, "template-before")
	saved, err := s.SaveCanvasPrompt("u", "c", req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateUserPromptCustomization(&model.User{ID: "u"}, promptOperationStoryboardVideo, UserPromptCustomizationRequest{Mode: "append", Content: "只影响视频草稿"}); err != nil {
		t.Fatal(err)
	}
	current, err := s.GetCanvasPrompt("u", "c", target)
	if err != nil || current.Stale {
		t.Fatalf("unrelated kind changed image dependencies: %+v %v", current, err)
	}
	if _, err := s.UpdateUserPromptCustomization(&model.User{ID: "u"}, promptOperationStoryboardFirstFrame, UserPromptCustomizationRequest{Mode: "append", Content: "用户定制：干净无颗粒，不新增人物"}); err != nil {
		t.Fatal(err)
	}
	current, err = s.GetCanvasPrompt("u", "c", target)
	if err != nil || !current.Stale || !strings.Contains(current.Dependencies.Guidance.Content, "用户定制：干净无颗粒") || current.Dependencies.Guidance.CustomizationID == "" {
		t.Fatalf("native customization missing or not stale: %+v %v", current, err)
	}
	req.RequestID, req.ExpectedRevision, req.ExpectedContentHash = "template-stale", &current.State.Revision, current.State.ContentHash
	if _, err := s.SaveCanvasPrompt("u", "c", req); err == nil {
		t.Fatal("old template dependency allowed a new write")
	}
	history, err := s.GetCanvasPromptRevision("u", "c", target.NodeID, target.RowID, target.Kind, 1)
	if err != nil || string(history.Dependencies) != string(saved.Receipt.Snapshot.Dependencies) || strings.Contains(string(history.Dependencies), "用户定制：干净无颗粒") {
		t.Fatalf("historical template overwritten: %v", err)
	}
	promptCounts(t, db, 2, 1)
}

func TestCanvasPromptSaveReadbackHistoryReplayAndExactText(t *testing.T) {
	s, db, target := promptTestService(t)
	before, _ := s.repo.CanvasProjectForUser("u", "c")
	context, err := s.GetCanvasPrompt("u", "c", target)
	if err != nil || context.Managed || len(context.WriteBlockers) > 0 || len(context.LocalOverrides) > 0 {
		t.Fatalf("initial: %+v %v", context, err)
	}
	promptCounts(t, db, 0, 0)
	if after, _ := s.repo.CanvasProjectForUser("u", "c"); before.PayloadJSON != after.PayloadJSON {
		t.Fatal("read mutated source")
	}
	req := promptSaveRequest(t, s, target, "one")
	req.Prompt = "  第一段\n\n第二段：*符号也是正文*。\n"
	first, err := s.SaveCanvasPrompt("u", "c", req)
	if err != nil || first.Replayed {
		t.Fatalf("save: %+v %v", first, err)
	}
	context, err = s.GetCanvasPrompt("u", "c", target)
	if err != nil || !context.Managed || context.Stale || context.Prompt != req.Prompt || context.State.Revision != 1 || context.DependencyHash != req.DependencyHash {
		t.Fatalf("readback: %+v %v", context, err)
	}
	if first.Receipt.Snapshot.Prompt != context.Prompt || first.Receipt.Snapshot.ContentHash != repository.ScriptSourceHash(req.Prompt) {
		t.Fatal("receipt differs from current text")
	}
	history, err := s.repo.CanvasPromptRevisions("u", "c", target.NodeID, target.RowID, "image")
	if err != nil || len(history) != 2 || history[1].Revision != 0 || history[1].Prompt != "**原图词**，完整保留。" || history[1].DependencyHash != "" || !equalShotJSON(t, history[1].Dependencies, json.RawMessage(`null`)) {
		t.Fatalf("baseline: %+v %v", history, err)
	}
	if !equalShotJSON(t, history[0], first.Receipt.Snapshot) {
		t.Fatal("persisted history and receipt differ")
	}
	replay, err := s.SaveCanvasPrompt("u", "c", req)
	if err != nil || !replay.Replayed || !equalShotJSON(t, replay.Receipt, first.Receipt) {
		t.Fatal("retry did not return exact prior receipt")
	}
	changed := req
	changed.Prompt += "改变请求"
	_, err = s.SaveCanvasPrompt("u", "c", changed)
	requireShotConflict(t, err)
	second, err := s.SaveCanvasPrompt("u", "c", promptSaveRequest(t, s, target, "two"))
	if err != nil || second.Receipt.Snapshot.Revision != 2 {
		t.Fatalf("second: %v", err)
	}
	replay, err = s.SaveCanvasPrompt("u", "c", req)
	if err != nil || !replay.Replayed || replay.Receipt.Snapshot.Revision != 1 {
		t.Fatal("historical retry lost")
	}
	promptCounts(t, db, 3, 2)
	canvas, _ := s.repo.CanvasProjectForUser("u", "c")
	doc, _ := model.ParseCanvasPromptDocument([]byte(canvas.PayloadJSON))
	row, _ := doc.Target(target.NodeID, target.RowID)
	other, _ := doc.Target("n", "other")
	if model.CanvasJSONText(row.Row, "videoMotionPrompt") != "旧视频词" || model.CanvasJSONText(other.Row, "imageGenerationPrompt") != "旁行不变" || model.CanvasJSONText(doc.Root, "updatedAt") == "" {
		t.Fatal("unrelated prompt changed or updatedAt missing")
	}
}

func TestCanvasPromptSourcesAndLocalOverrides(t *testing.T) {
	s, db, target := promptTestService(t)
	req := promptSaveRequest(t, s, target, "one")
	if _, err := s.SaveCanvasPrompt("u", "c", req); err != nil {
		t.Fatal(err)
	}
	current, _ := s.repo.CanvasProjectForUser("u", "c")
	current.PayloadJSON = strings.ReplaceAll(current.PayloadJSON, `"x":7`, `"x":8`)
	if err := s.repo.UpsertCanvasProject(current); err != nil {
		t.Fatal(err)
	}
	context, _ := s.GetCanvasPrompt("u", "c", target)
	if context.Stale {
		t.Fatal("layout falsely invalidated prompt")
	}
	// Change the effective camera only, not the import baseline or business Shot.
	doc, _ := model.ParseCanvasPromptDocument([]byte(current.PayloadJSON))
	row, _ := doc.Target("n", target.RowID)
	row.Row["camera"] = json.RawMessage(`"手工固定机位"`)
	raw, _ := row.SetPrompt("image", context.Prompt, context.State)
	current.PayloadJSON = string(raw)
	if err := s.repo.UpsertCanvasProject(current); err != nil {
		t.Fatal(err)
	}
	context, err := s.GetCanvasPrompt("u", "c", target)
	if err != nil || !context.Stale || len(context.LocalOverrides) != 1 || context.LocalOverrides[0] != "camera" || context.Dependencies.Shot.Content.Camera == "手工固定机位" {
		t.Fatalf("override: %+v %v", context, err)
	}
	oldRequest := req
	oldRequest.RequestID = "stale"
	oldRequest.ExpectedRevision = &context.State.Revision
	oldRequest.ExpectedContentHash = context.State.ContentHash
	_, err = s.SaveCanvasPrompt("u", "c", oldRequest)
	requireShotConflict(t, err)
	if _, err := s.SaveCanvasPrompt("u", "c", promptSaveRequest(t, s, target, "adopt-local")); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.ProjectUnit{}).Where("id = ?", "chapter").Updates(map[string]any{"source_text": shotTestSource + "<p>续写</p>", "revision": 2}).Error; err != nil {
		t.Fatal(err)
	}
	context, err = s.GetCanvasPrompt("u", "c", target)
	if err != nil || !context.Stale || len(context.WriteBlockers) == 0 {
		t.Fatal("source drift not exposed")
	}
	_, err = s.SaveCanvasPrompt("u", "c", promptSaveRequest(t, s, target, "stale-source"))
	requireShotConflict(t, err)
	promptCounts(t, db, 3, 2)
}

func TestCanvasPromptRejectsWrongScopeAndStaleBaseline(t *testing.T) {
	s, db, target := promptTestService(t)
	req := promptSaveRequest(t, s, target, "one")
	for _, modify := range []func(*SaveCanvasPromptRequest){
		func(r *SaveCanvasPromptRequest) { r.ProjectID = "foreign" }, func(r *SaveCanvasPromptRequest) { r.RowID = "project-shot:missing" }, func(r *SaveCanvasPromptRequest) { r.Kind = "audio" }, func(r *SaveCanvasPromptRequest) { r.DependencyHash = strings.Repeat("f", 64) }, func(r *SaveCanvasPromptRequest) { r.ExpectedContentHash = strings.Repeat("f", 64) }, func(r *SaveCanvasPromptRequest) { r.ExpectedRevision = nil },
	} {
		bad := req
		modify(&bad)
		if _, err := s.SaveCanvasPrompt("u", "c", bad); err == nil {
			t.Fatal("invalid input accepted")
		}
	}
	if _, err := s.SaveCanvasPrompt("other", "c", req); err == nil {
		t.Fatal("foreign owner accepted")
	}
	if err := db.Model(&model.Shot{}).Where("id = ?", strings.TrimPrefix(target.RowID, "project-shot:")).Update("unit_id", "other-chapter").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetCanvasPrompt("u", "c", target); err == nil {
		t.Fatal("wrong unit accepted")
	}
	promptCounts(t, db, 0, 0)
}

func TestCanvasPromptTransactionRollbackAndConcurrentServices(t *testing.T) {
	s, db, target := promptTestService(t)
	req := promptSaveRequest(t, s, target, "one")
	before, _ := s.repo.CanvasProjectForUser("u", "c")
	if err := db.Exec(`CREATE TRIGGER reject_canvas_prompt_update BEFORE UPDATE ON canvas_projects BEGIN SELECT RAISE(ABORT,'injected'); END`).Error; err != nil {
		t.Fatal(err)
	}
	if result, err := s.SaveCanvasPrompt("u", "c", req); err == nil || result.Receipt.ID != "" {
		t.Fatal("failed update reported persisted")
	}
	promptCounts(t, db, 0, 0)
	if current, _ := s.repo.CanvasProjectForUser("u", "c"); current.PayloadJSON != before.PayloadJSON {
		t.Fatal("rollback changed source")
	}
	if err := db.Exec(`DROP TRIGGER reject_canvas_prompt_update`).Error; err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, id := range []string{"a", "b"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			other := &Service{repo: repository.New(db)}
			r := req
			r.RequestID = id
			r.Prompt = id
			<-start
			_, err := other.SaveCanvasPrompt("u", "c", r)
			results <- err
		}(id)
	}
	close(start)
	wg.Wait()
	close(results)
	winners := 0
	for err := range results {
		if err == nil {
			winners++
		} else {
			var app *AppError
			if !errors.As(err, &app) || app.Status != 409 {
				t.Fatalf("concurrency not classified: %v", err)
			}
		}
	}
	if winners != 1 {
		t.Fatalf("winners=%d", winners)
	}
	promptCounts(t, db, 2, 1)
}

func TestCanvasPromptResolvesActualAssetVersionsAndDetectsChanges(t *testing.T) {
	s, db, target := promptTestService(t)
	for _, item := range []any{
		&model.Asset{ID: "actor", UserID: "u", PrimaryVersionID: "v1", Title: "林夏"},
		&model.AssetVersion{ID: "v1", AssetID: "actor", Version: 1, DefinitionJSON: `{"name":"林夏","wardrobe":"灰色外套"}`, Prompt: "角色设定一"},
		&model.AssetVersion{ID: "v2", AssetID: "actor", Version: 2, DefinitionJSON: `{"name":"林夏","wardrobe":"蓝色外套"}`, Prompt: "角色设定二"},
		&model.ProjectAssetLink{ID: "asset-link", ProjectID: "p", AssetID: "actor"},
		&model.ShotAssetReference{ID: "shot-ref", ShotID: strings.TrimPrefix(target.RowID, "project-shot:"), AssetVersionID: "v1", Role: "character", Status: "confirmed"},
	} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	canvas, _ := s.repo.CanvasProjectForUser("u", "c")
	// Modify fixture source before any prompt is managed.
	var root map[string]any
	_ = json.Unmarshal([]byte(canvas.PayloadJSON), &root)
	rows := root["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)["storyboard"].(map[string]any)["rows"].([]any)
	rows[0].(map[string]any)["characters"] = []any{map[string]any{"characterName": "林夏", "characterAssetId": "actor"}}
	raw, _ := json.Marshal(root)
	canvas.PayloadJSON = string(raw)
	if err := s.repo.UpsertCanvasProject(canvas); err != nil {
		t.Fatal(err)
	}
	context, err := s.GetCanvasPrompt("u", "c", target)
	if err != nil || len(context.Dependencies.Assets) != 2 {
		t.Fatalf("asset context: %+v %v", context.Dependencies.Assets, err)
	}
	for _, asset := range context.Dependencies.Assets {
		if asset.Version == nil || asset.Version.ID != "v1" || asset.Version.DefinitionJSON != `{"name":"林夏","wardrobe":"灰色外套"}` || asset.VisualVerified {
			t.Fatal("asset version fabricated or claimed visual proof")
		}
	}
	if _, err := s.SaveCanvasPrompt("u", "c", promptSaveRequest(t, s, target, "asset-v1")); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Asset{}).Where("id = ?", "actor").Update("primary_version_id", "v2").Error; err != nil {
		t.Fatal(err)
	}
	context, err = s.GetCanvasPrompt("u", "c", target)
	if err != nil || !context.Stale {
		t.Fatal("changed active asset version not detected")
	}
	if context.Dependencies.Assets[0].Version.ID != "v1" || context.Dependencies.Assets[1].Version.ID != "v2" {
		t.Fatal("pinned shot version was replaced with current version")
	}
	// A foreign owner behind a project link is still not accessible.
	if err := db.Model(&model.Asset{}).Where("id = ?", "actor").Update("user_id", "other").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetCanvasPrompt("u", "c", target); err == nil {
		t.Fatal("foreign asset exposed")
	}
	history, err := s.GetCanvasPromptHistory("u", "c", target.NodeID, target.RowID, target.Kind)
	if err != nil || len(history) != 2 {
		t.Fatal("missing upstream asset prevented draft recovery")
	}
	promptCounts(t, db, 2, 1)
}

func TestCanvasPromptExplicitDetachAndDeletePreserveScope(t *testing.T) {
	s, db, target := promptTestService(t)
	if _, err := s.SaveCanvasPrompt("u", "c", promptSaveRequest(t, s, target, "one")); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteUserCanvasProject("other", "c"); err == nil {
		t.Fatal("foreign canvas deletion accepted")
	}
	promptCounts(t, db, 2, 1)
	if _, err := s.LinkCanvasUnit("u", "foreign", LinkCanvasUnitRequest{CanvasID: "c", UnitID: "chapter"}); err == nil {
		t.Fatal("foreign project assignment accepted")
	}
	if err := s.repo.AssignCanvasToProject("u", "c", "elsewhere"); !errors.Is(err, model.ErrCanvasPromptConflict) {
		t.Fatal("managed prompt moved to other project")
	}
	if err := s.UnlinkCanvasProject("u", "p", "c"); err != nil {
		t.Fatal(err)
	}
	canvas, _ := s.repo.CanvasProjectForUser("u", "c")
	if canvas.ProjectID != "" || !strings.Contains(canvas.PayloadJSON, "测试正文 one") {
		t.Fatal("detach lost prompt")
	}
	if _, err := s.GetCanvasPromptRevision("u", "c", target.NodeID, target.RowID, target.Kind, 1); err != nil {
		t.Fatal("detached history unavailable")
	}
	promptCounts(t, db, 2, 1)
	if err := s.DeleteUserCanvasProject("u", "c"); err != nil {
		t.Fatal(err)
	}
	promptCounts(t, db, 0, 0)
}

func TestCanvasPromptResourceBindingsAreOwnedAndVersioned(t *testing.T) {
	s, db, target := promptTestService(t)
	if err := db.Create(&model.Resource{ID: "image", UserID: "u", Status: model.ResourceStatusReady, MimeType: "image/png", Size: 21, ETag: "first"}).Error; err != nil {
		t.Fatal(err)
	}
	canvas, _ := s.repo.CanvasProjectForUser("u", "c")
	var root map[string]any
	_ = json.Unmarshal([]byte(canvas.PayloadJSON), &root)
	nodes := root["nodes"].([]any)
	row := nodes[0].(map[string]any)["metadata"].(map[string]any)["storyboard"].(map[string]any)["rows"].([]any)[0].(map[string]any)
	row["assetBindings"] = []any{map[string]any{"nodeId": "image-node", "role": "environment", "priority": 1}}
	root["nodes"] = append(nodes, map[string]any{"id": "image-node", "type": "image", "title": "场景参照", "metadata": map[string]any{"storageKey": "resource:image"}})
	raw, _ := json.Marshal(root)
	canvas.PayloadJSON = string(raw)
	if err := s.repo.UpsertCanvasProject(canvas); err != nil {
		t.Fatal(err)
	}
	context, err := s.GetCanvasPrompt("u", "c", target)
	if err != nil || len(context.Dependencies.Assets) != 1 || context.Dependencies.Assets[0].Resource["etag"] != "first" || context.Dependencies.Assets[0].VisualVerified {
		t.Fatal("resource identity not resolved")
	}
	if _, err := s.SaveCanvasPrompt("u", "c", promptSaveRequest(t, s, target, "with-resource")); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Resource{}).Where("id = ?", "image").Update("e_tag", "second").Error; err != nil {
		t.Fatal(err)
	}
	context, err = s.GetCanvasPrompt("u", "c", target)
	if err != nil || !context.Stale {
		t.Fatal("changed resource identity not marked stale")
	}
	if err := db.Model(&model.Resource{}).Where("id = ?", "image").Update("user_id", "other").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetCanvasPrompt("u", "c", target); err == nil {
		t.Fatal("foreign resource exposed")
	}
}

func TestCanvasPromptUsesNativeGlobalRowTargetAndFirstFrameReferences(t *testing.T) {
	s, db, target := promptTestService(t)
	if err := db.Create(&model.Resource{ID: "frame-resource", UserID: "u", Status: model.ResourceStatusReady, MimeType: "image/png", Size: 12, ETag: "frame"}).Error; err != nil {
		t.Fatal(err)
	}
	canvas, _ := s.repo.CanvasProjectForUser("u", "c")
	var root map[string]any
	_ = json.Unmarshal([]byte(canvas.PayloadJSON), &root)
	nodes := root["nodes"].([]any)
	storyboard := nodes[0].(map[string]any)["metadata"].(map[string]any)["storyboard"].(map[string]any)
	storyboard["referenceNodeIds"] = []string{"global", "frame"}
	row := storyboard["rows"].([]any)[0].(map[string]any)
	row["imageNodeId"] = "frame"
	row["videoNodeId"] = "video"
	row["assetBindings"] = []any{map[string]any{"nodeId": "global", "role": "environment"}, map[string]any{"nodeId": "row-ref", "role": "prop"}}
	for _, id := range []string{"global", "row-ref", "image-input", "video-input", "video"} {
		nodes = append(nodes, map[string]any{"id": id, "type": "text", "metadata": map[string]any{"content": "参照 " + id}})
	}
	root["nodes"] = append(nodes, map[string]any{"id": "frame", "type": "image", "metadata": map[string]any{"storageKey": "resource:frame-resource"}})
	root["connections"] = []any{map[string]any{"fromNodeId": "image-input", "toNodeId": "frame"}, map[string]any{"fromNodeId": "row-ref", "toNodeId": "n", "toHandleId": "row:" + target.RowID}, map[string]any{"fromNodeId": "video-input", "toNodeId": "video"}}
	raw, _ := json.Marshal(root)
	canvas.PayloadJSON = string(raw)
	if err := s.repo.UpsertCanvasProject(canvas); err != nil {
		t.Fatal(err)
	}
	for _, check := range []struct {
		kind string
		ids  []string
	}{{"image", []string{"global", "row-ref", "image-input"}}, {"video", []string{"global", "frame", "row-ref", "video-input"}}} {
		req := target
		req.Kind = check.kind
		context, err := s.GetCanvasPrompt("u", "c", req)
		if err != nil {
			t.Fatal(err)
		}
		ids := []string{}
		for _, asset := range context.Dependencies.Assets {
			ids = append(ids, asset.NodeID)
			if check.kind == "video" && asset.NodeID == "frame" && (asset.Role != "first-frame" || asset.Resource["id"] != "frame-resource") {
				t.Fatal("first frame binding lost")
			}
		}
		if !equalShotJSON(t, ids, check.ids) {
			t.Fatalf("%s refs=%v want=%v", check.kind, ids, check.ids)
		}
	}
}
