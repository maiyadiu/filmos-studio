package service

import (
	"net/http"
	"path/filepath"
	"sync"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func scriptFixture(t *testing.T) (*Service, *gorm.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "script.db")
	db, err := gorm.Open(sqlite.Open(path+"?_busy_timeout=5000&_journal_mode=WAL"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	t.Cleanup(func() { _ = conn.Close() })
	if err := db.AutoMigrate(&model.Project{}, &model.ProjectUnit{}, &model.ProjectUnitRevision{}); err != nil {
		t.Fatal(err)
	}
	for _, item := range []any{
		&model.Project{ID: "project", UserID: "owner", Name: "隔离剧本样例", Status: model.ProjectStatusActive, Revision: 1},
		&model.Project{ID: "other-project", UserID: "other", Name: "另一个项目", Status: model.ProjectStatusActive, Revision: 1},
		&model.ProjectUnit{ID: "unit", ProjectID: "project", Title: "第一场", SourceText: "<p>场景：客厅</p><p>林夏：我不走。</p><p>动作：门关上。</p>", Status: model.ProjectUnitStatusDraft, Revision: 1},
	} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	return &Service{repo: repository.New(db)}, db, path
}

func scriptEdit() UpdateProjectUnitRequest {
	return UpdateProjectUnitRequest{ExpectedRevision: 1, RequestID: "edit-one", Note: "只修改林夏的对白", SourceText: "<p>场景：客厅</p><p>林夏：我陪你。</p><p>动作：门关上。</p>"}
}

func TestScriptRevisionPersistsAndRetainsOriginalAfterReopen(t *testing.T) {
	svc, db, path := scriptFixture(t)
	before, err := svc.GetProjectScriptRevision("owner", "project", "unit", 1)
	if err != nil {
		t.Fatal(err)
	}
	got, err := svc.ReviseProjectScript("owner", "project", "unit", scriptEdit())
	if err != nil {
		t.Fatal(err)
	}
	if got.Unit.Revision != 2 || got.Revision.SourceText != scriptEdit().SourceText || got.Revision.CreatedBy != "owner" {
		t.Fatalf("wrong revision: %+v", got)
	}
	var project model.Project
	db.First(&project, "id = ?", "project")
	if project.Revision != 2 {
		t.Fatal("project was not invalidated exactly once")
	}
	reopened, err := gorm.Open(sqlite.Open(path), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := reopened.DB()
	defer conn.Close()
	reader := &Service{repo: repository.New(reopened)}
	original, err := reader.GetProjectScriptRevision("owner", "project", "unit", 1)
	if err != nil {
		t.Fatal(err)
	}
	after, err := reader.GetProjectScriptRevision("owner", "project", "unit", 2)
	if err != nil {
		t.Fatal(err)
	}
	if original.SourceText != before.SourceText || original.SourceHash != before.SourceHash || after.SourceHash != repository.ScriptSourceHash(scriptEdit().SourceText) {
		t.Fatal("persisted version text/hash mismatch")
	}
	list, err := reader.GetProjectScriptRevisions("owner", "project", "unit")
	if err != nil || len(list) != 2 || list[0].Revision != 2 || list[0].SourceText != "" {
		t.Fatalf("history must list metadata newest first: %+v %v", list, err)
	}
}

func TestScriptRevisionRetryConflictAndScope(t *testing.T) {
	svc, db, _ := scriptFixture(t)
	first, err := svc.ReviseProjectScript("owner", "project", "unit", scriptEdit())
	if err != nil {
		t.Fatal(err)
	}
	retry, err := svc.ReviseProjectScript("owner", "project", "unit", scriptEdit())
	if err != nil || !retry.Replayed || retry.Revision.ID != first.Revision.ID {
		t.Fatalf("retry: %+v %v", retry, err)
	}
	reused := scriptEdit()
	reused.SourceText = "different"
	_, err = svc.ReviseProjectScript("owner", "project", "unit", reused)
	assertAppStatus(t, err, http.StatusConflict)
	stale := scriptEdit()
	stale.RequestID = "other-request"
	_, err = svc.ReviseProjectScript("owner", "project", "unit", stale)
	assertAppStatus(t, err, http.StatusConflict)
	if _, err := svc.GetProjectScriptRevision("other", "project", "unit", 1); !IsProjectNotFound(err) {
		t.Fatalf("cross-user read: %v", err)
	}
	if _, err := svc.ReviseProjectScript("other", "project", "unit", stale); !IsProjectNotFound(err) {
		t.Fatalf("cross-user write: %v", err)
	}
	if _, err := svc.GetProjectScriptRevision("other", "other-project", "unit", 1); !IsProjectNotFound(err) {
		t.Fatalf("cross-project unit: %v", err)
	}
	var count int64
	db.Model(&model.ProjectUnitRevision{}).Count(&count)
	if count != 2 {
		t.Fatalf("retries/conflicts added revisions: %d", count)
	}
	var project model.Project
	db.First(&project, "id = ?", "project")
	if project.Revision != 2 {
		t.Fatal("retry bumped project revision")
	}
}

func TestScriptRevisionSecondEditAndManualSaveUseSameHistory(t *testing.T) {
	svc, _, _ := scriptFixture(t)
	if _, err := svc.ReviseProjectScript("owner", "project", "unit", scriptEdit()); err != nil {
		t.Fatal(err)
	}
	next := scriptEdit()
	next.ExpectedRevision = 2
	next.RequestID = "manual-save"
	next.SourceText += "<p>她转身。</p>"
	next.Note = "手动保存"
	unit, err := svc.UpdateProjectUnit("owner", "project", "unit", next)
	if err != nil || unit.Revision != 3 {
		t.Fatalf("manual: %+v %v", unit, err)
	}
	rows, err := svc.GetProjectScriptRevisions("owner", "project", "unit")
	if err != nil || len(rows) != 3 {
		t.Fatalf("history: %+v %v", rows, err)
	}
}

func TestScriptRevisionLegacyMigrationPreservesBody(t *testing.T) {
	svc, db, _ := scriptFixture(t)
	original, err := svc.GetProjectUnit("owner", "project", "unit")
	if err != nil {
		t.Fatal(err)
	}
	// Reproduce the old schema in this disposable database, then apply the
	// same additive GORM model migration used by startup.
	if err := db.Migrator().DropColumn(&model.ProjectUnit{}, "revision"); err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.ProjectUnit{}, &model.ProjectUnitRevision{}); err != nil {
		t.Fatal(err)
	}
	unit, err := svc.GetProjectUnit("owner", "project", "unit")
	if err != nil || unit.Revision != 1 || unit.SourceText != original.SourceText || unit.Title != original.Title {
		t.Fatalf("legacy migration changed chapter: %+v %v", unit, err)
	}
	if _, err := svc.ReviseProjectScript("owner", "project", "unit", scriptEdit()); err != nil {
		t.Fatal(err)
	}
	before, err := svc.GetProjectScriptRevision("owner", "project", "unit", 1)
	if err != nil || before.SourceText != original.SourceText {
		t.Fatal("legacy original not retained")
	}
}

func TestScriptRevisionConcurrentWritesCannotLoseOriginal(t *testing.T) {
	svc, db, _ := scriptFixture(t)
	var wg sync.WaitGroup
	start := make(chan struct{})
	errors := make(chan error, 2)
	for _, id := range []string{"writer-a", "writer-b"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			<-start
			req := scriptEdit()
			req.RequestID = id
			req.SourceText += id
			_, err := svc.ReviseProjectScript("owner", "project", "unit", req)
			errors <- err
		}(id)
	}
	close(start)
	wg.Wait()
	close(errors)
	successes := 0
	for err := range errors {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("expected exactly one committed writer, got %d", successes)
	}
	unit, err := svc.GetProjectUnit("owner", "project", "unit")
	if err != nil {
		t.Fatal(err)
	}
	var rows []model.ProjectUnitRevision
	if err := db.Order("revision").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if unit.Revision != 2 || len(rows) != 2 || rows[0].Revision != 1 || rows[1].SourceText != unit.SourceText || rows[0].SourceText == unit.SourceText {
		t.Fatal("concurrent write lost original or created partial history")
	}
}

func TestScriptRevisionRollbackAndProtectedStates(t *testing.T) {
	t.Run("atomic rollback", func(t *testing.T) {
		svc, db, _ := scriptFixture(t)
		if err := db.Exec("CREATE TRIGGER fail_revision BEFORE INSERT ON project_unit_revisions WHEN NEW.revision = 2 BEGIN SELECT RAISE(ABORT, 'test failure'); END").Error; err != nil {
			t.Fatal(err)
		}
		if _, err := svc.ReviseProjectScript("owner", "project", "unit", scriptEdit()); err == nil {
			t.Fatal("expected injected persistence failure")
		}
		unit, _ := svc.GetProjectUnit("owner", "project", "unit")
		var count int64
		db.Model(&model.ProjectUnitRevision{}).Count(&count)
		if unit.Revision != 1 || unit.SourceText == scriptEdit().SourceText || count != 0 {
			t.Fatal("partial write escaped rollback")
		}
	})
	for _, state := range []string{"completed", "archived", "missing guard", "state transition"} {
		t.Run(state, func(t *testing.T) {
			svc, db, _ := scriptFixture(t)
			req := scriptEdit()
			status := http.StatusConflict
			switch state {
			case "completed":
				db.Model(&model.ProjectUnit{}).Where("id = ?", "unit").Update("status", model.ProjectUnitStatusCompleted)
			case "archived":
				db.Model(&model.Project{}).Where("id = ?", "project").Update("status", model.ProjectStatusArchived)
			case "missing guard":
				req.ExpectedRevision = 0
				status = http.StatusBadRequest
			case "state transition":
				req.Status = "completed"
				status = http.StatusBadRequest
			}
			_, err := svc.ReviseProjectScript("owner", "project", "unit", req)
			assertAppStatus(t, err, status)
			var count int64
			db.Model(&model.ProjectUnitRevision{}).Count(&count)
			if count != 0 {
				t.Fatal("rejected write left history")
			}
		})
	}
}
