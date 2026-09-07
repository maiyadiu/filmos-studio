package service

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestScriptBatchUsesStandardProjectDirectory(t *testing.T) {
	s, db, _ := directoryServiceFixture(t)
	p, err := s.CreateProject("local-user", CreateProjectRequest{Name: "编剧目录", LocalDirectory: &CreateProjectDirectoryRequest{RequestID: "batch-project"}})
	if err != nil {
		t.Fatal(err)
	}
	req := batchRequest()
	req.ExpectedProjectRevision = p.Revision
	created, err := s.CreateProjectScriptBatch("local-user", p.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	status, err := s.ProjectDirectoryStatus("local-user", p.ID)
	if err != nil || status.State != "ready" {
		t.Fatal(status, err)
	}
	receiptBytes, err := os.ReadFile(filepath.Join(status.Path, "历史", "建章-"+created.Receipt.ID+".json"))
	var receipt model.ProjectScriptBatch
	if err != nil || json.Unmarshal(receiptBytes, &receipt) != nil || receipt.RequestID != req.RequestID || receipt.ProjectID != p.ID || len(receipt.UnitIDs) != 2 || receipt.UnitIDs[0] != created.Receipt.UnitIDs[0] {
		t.Fatal("creation receipt missing from standard directory", err)
	}
	for i, id := range created.Receipt.UnitIDs {
		b, readErr := os.ReadFile(filepath.Join(status.Path, "剧本", id+".html"))
		if readErr != nil || string(b) != req.Chapters[i].SourceText {
			t.Fatal("initial file mismatch", readErr)
		}
		b, readErr = os.ReadFile(filepath.Join(status.Path, "历史", "剧本-"+id+"-v1.json"))
		var old model.ProjectUnitRevision
		if readErr != nil || json.Unmarshal(b, &old) != nil || old.SourceText != req.Chapters[i].SourceText || old.RequestID != req.RequestID {
			t.Fatal("initial history missing", readErr)
		}
	}
	id := created.Receipt.UnitIDs[0]
	polished := req.Chapters[0].SourceText + "<p>修订</p>"
	if _, err = s.ReviseProjectScript("local-user", p.ID, id, UpdateProjectUnitRequest{ExpectedRevision: 1, RequestID: "batch-polish", SourceText: polished, Note: "打磨"}); err != nil {
		t.Fatal(err)
	}
	if replay, replayErr := s.CreateProjectScriptBatch("local-user", p.ID, req); replayErr != nil || !replay.Replayed {
		t.Fatal(replayErr)
	}
	b, err := os.ReadFile(filepath.Join(status.Path, "剧本", id+".html"))
	if err != nil || string(b) != polished {
		t.Fatal("replay overwrote current file", err)
	}
	// An unavailable bound directory must fail before adding another batch.
	if err = os.Rename(status.Path, status.Path+"-离线"); err != nil {
		t.Fatal(err)
	}
	req.RequestID = "offline-batch"
	current, err := s.repo.ProjectForUser("local-user", p.ID)
	if err != nil {
		t.Fatal(err)
	}
	req.ExpectedProjectRevision = current.Revision
	if _, err = s.CreateProjectScriptBatch("local-user", p.ID, req); err == nil {
		t.Fatal("offline directory accepted")
	}
	var count int64
	db.Model(&model.ProjectUnit{}).Where("project_id = ?", p.ID).Count(&count)
	if count != 2 {
		t.Fatal("offline write created chapters")
	}
}

func batchRequest() CreateProjectScriptBatchRequest {
	return CreateProjectScriptBatchRequest{ExpectedProjectRevision: 1, RequestID: "create-draft", Note: "从创意编剧", Chapters: []ScriptChapterInput{{Title: "雨夜", SourceText: "<p>场景：门外。</p><p>林：等我。</p>"}, {Title: "黎明", SourceText: "<p>动作：门开了。</p>"}}}
}

func TestScriptBatchCreationReplayAndHistory(t *testing.T) {
	svc, db, _ := scriptFixture(t)
	if err := db.AutoMigrate(&model.ProjectScriptBatch{}); err != nil {
		t.Fatal(err)
	}
	req := batchRequest()
	result, err := svc.CreateProjectScriptBatch("owner", "project", req)
	if err != nil {
		t.Fatal(err)
	}
	if result.Replayed || result.Receipt.ProjectRevision != 2 || len(result.Revisions) != 2 {
		t.Fatalf("bad receipt: %+v", result)
	}
	for i, row := range result.Revisions {
		unit, err := svc.GetProjectUnit("owner", "project", row.UnitID)
		if err != nil || row.SourceText != req.Chapters[i].SourceText || row.Revision != 1 || unit.Revision != 1 || unit.Position != i+1 {
			t.Fatalf("bad created chapter: %+v %v", unit, err)
		}
	}
	edit := UpdateProjectUnitRequest{ExpectedRevision: 1, RequestID: "polish", SourceText: "<p>修订后的剧本</p>", Note: "打磨"}
	if _, err := svc.ReviseProjectScript("owner", "project", result.Receipt.UnitIDs[0], edit); err != nil {
		t.Fatal(err)
	}
	retry, err := svc.CreateProjectScriptBatch("owner", "project", req)
	if err != nil || !retry.Replayed || retry.Receipt.ID != result.Receipt.ID || retry.Revisions[0].SourceText != req.Chapters[0].SourceText {
		t.Fatalf("bad replay: %+v %v", retry, err)
	}
	var count int64
	db.Model(&model.ProjectUnit{}).Where("project_id = ?", "project").Count(&count)
	if count != 3 {
		t.Fatal("duplicate creation")
	}
	unit, _ := svc.GetProjectUnit("owner", "project", result.Receipt.UnitIDs[0])
	if unit.SourceText != edit.SourceText || unit.Revision != 2 {
		t.Fatal("replay overwrote subsequent edit")
	}
	_, err = svc.GetProjectScriptBatch("other", "project", req.RequestID)
	if err == nil {
		t.Fatal("cross-user read")
	}
	changed := req
	changed.Note = "changed request"
	_, err = svc.CreateProjectScriptBatch("owner", "project", changed)
	assertAppStatus(t, err, http.StatusConflict)
	stale := req
	stale.RequestID = "stale"
	_, err = svc.CreateProjectScriptBatch("owner", "project", stale)
	assertAppStatus(t, err, http.StatusConflict)
}

func TestScriptBatchValidationAndRollback(t *testing.T) {
	svc, db, _ := scriptFixture(t)
	if err := db.AutoMigrate(&model.ProjectScriptBatch{}); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*CreateProjectScriptBatchRequest){
		func(r *CreateProjectScriptBatchRequest) { r.Chapters[1].SourceText = " " },
		func(r *CreateProjectScriptBatchRequest) { r.ExpectedProjectRevision = 0 },
		func(r *CreateProjectScriptBatchRequest) { r.RequestID = "" },
		func(r *CreateProjectScriptBatchRequest) { r.Chapters = nil },
	} {
		req := batchRequest()
		mutate(&req)
		_, err := svc.CreateProjectScriptBatch("owner", "project", req)
		assertAppStatus(t, err, http.StatusBadRequest)
	}
	if _, err := svc.CreateProjectScriptBatch("other", "project", batchRequest()); err == nil {
		t.Fatal("cross-user creation")
	}
	// Fault after chapter insertion must roll back chapters, history and revision.
	if err := db.Exec("CREATE TRIGGER script_batch_failure BEFORE INSERT ON project_script_batches BEGIN SELECT RAISE(ABORT, 'fixture failure'); END").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateProjectScriptBatch("owner", "project", batchRequest()); err == nil {
		t.Fatal("expected failure")
	}
	var count int64
	db.Model(&model.ProjectUnit{}).Where("project_id = ?", "project").Count(&count)
	if count != 1 {
		t.Fatal("partial chapters")
	}
	db.Model(&model.ProjectUnitRevision{}).Count(&count)
	if count != 0 {
		t.Fatal("partial history")
	}
	p, _ := svc.repo.ProjectForUser("owner", "project")
	if p.Revision != 1 {
		t.Fatal("partial revision")
	}
}
