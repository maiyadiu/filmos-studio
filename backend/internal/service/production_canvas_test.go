package service

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

func TestAcquireProductionCanvasDefaultsOffWithoutWrites(t *testing.T) {
	service, db, project, unit := productionCanvasFixture(t)
	t.Setenv(productionCanvasWriteEnv, "")

	_, err := service.AcquireProductionCanvas(project.UserID, project.ID, unit.ID, AcquireProductionCanvasRequest{
		HumanConfirmed: true, ConfirmationID: "confirm-off-001", ExpectedRevision: project.Revision, ExpectedContentHash: hostUnitSourceHash(unit.SourceText),
	})
	assertAppStatus(t, err, http.StatusForbidden)
	assertProductionCanvasCounts(t, db, project.ID, unit.ID, 0, 0)
	assertProjectRevision(t, db, project.ID, project.Revision)
}

func TestAcquireProductionCanvasRequiresHumanAndExactSourceHash(t *testing.T) {
	service, db, project, unit := productionCanvasFixture(t)
	t.Setenv(productionCanvasWriteEnv, "true")

	_, err := service.AcquireProductionCanvas(project.UserID, project.ID, unit.ID, AcquireProductionCanvasRequest{
		ConfirmationID: "confirm-human-001", ExpectedRevision: project.Revision, ExpectedContentHash: hostUnitSourceHash(unit.SourceText),
	})
	assertAppStatus(t, err, http.StatusBadRequest)
	_, err = service.AcquireProductionCanvas(project.UserID, project.ID, unit.ID, AcquireProductionCanvasRequest{
		HumanConfirmed: true, ConfirmationID: "confirm-hash-001", ExpectedRevision: project.Revision, ExpectedContentHash: "0" + hostUnitSourceHash(unit.SourceText)[1:],
	})
	assertAppStatus(t, err, http.StatusConflict)
	assertProductionCanvasCounts(t, db, project.ID, unit.ID, 0, 0)
}

func TestAcquireProductionCanvasCreatesOnceAndReplaysByUnitIdentity(t *testing.T) {
	service, db, project, unit := productionCanvasFixture(t)
	t.Setenv(productionCanvasWriteEnv, "true")
	hash := hostUnitSourceHash(unit.SourceText)
	req := AcquireProductionCanvasRequest{HumanConfirmed: true, ConfirmationID: "confirm-create-001", ExpectedRevision: project.Revision, ExpectedContentHash: hash}

	created, err := service.AcquireProductionCanvas(project.UserID, project.ID, unit.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	if created.Disposition != "created" || created.ProjectRevision != project.Revision+1 || created.Link.Role != productionCanvasRole {
		t.Fatalf("unexpected create result: %+v", created)
	}
	var payload productionCanvasDocument
	if err := json.Unmarshal([]byte(created.Canvas.PayloadJSON), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.ID != created.Canvas.ID || payload.ProjectID != project.ID {
		t.Fatalf("unexpected Host canvas payload: %+v", payload)
	}
	if strings.Contains(created.Canvas.PayloadJSON, "filmProduction") || strings.Contains(created.Canvas.PayloadJSON, hash) {
		t.Fatalf("Host payload must not persist Film or source-hash authority: %s", created.Canvas.PayloadJSON)
	}

	// A transport retry may still carry the pre-create revision. Existing identity
	// is resolved before revision comparison and must return the same Host objects.
	replayed, err := service.AcquireProductionCanvas(project.UserID, project.ID, unit.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	if replayed.Disposition != "reused" || replayed.Canvas.ID != created.Canvas.ID || replayed.Link.ID != created.Link.ID || replayed.ProjectRevision != project.Revision+1 {
		t.Fatalf("unexpected replay result: %+v", replayed)
	}
	assertProductionCanvasCounts(t, db, project.ID, unit.ID, 1, 1)
	assertProjectRevision(t, db, project.ID, project.Revision+1)
	var auditCount int64
	if err := db.Model(&model.AdminAuditEvent{}).Where("id = ? AND action = ?", created.AuditEventID, "production_canvas.acquire").Count(&auditCount).Error; err != nil || auditCount != 1 {
		t.Fatalf("audit count = %d, error = %v", auditCount, err)
	}
}

func TestAcquireProductionCanvasRevisionAndDuplicateConflictsAreZeroWrite(t *testing.T) {
	service, db, project, unit := productionCanvasFixture(t)
	t.Setenv(productionCanvasWriteEnv, "true")
	hash := hostUnitSourceHash(unit.SourceText)

	_, err := service.AcquireProductionCanvas(project.UserID, project.ID, unit.ID, AcquireProductionCanvasRequest{
		HumanConfirmed: true, ConfirmationID: "confirm-revision-001", ExpectedRevision: project.Revision + 1, ExpectedContentHash: hash,
	})
	assertAppStatus(t, err, http.StatusConflict)
	assertProductionCanvasCounts(t, db, project.ID, unit.ID, 0, 0)

	now := project.UpdatedAt
	for index, id := range []string{"legacy-a", "legacy-b"} {
		canvas := model.CanvasProject{ID: id, UserID: project.UserID, ProjectID: project.ID, Title: id, PayloadJSON: `{}`, CreatedAt: now, UpdatedAt: now}
		link := model.CanvasUnitLink{ID: "link-" + id, ProjectID: project.ID, CanvasID: id, UnitID: unit.ID, Role: productionCanvasRole, CreatedAt: now.AddDate(0, 0, index)}
		if err := db.Create(&canvas).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&link).Error; err != nil {
			t.Fatal(err)
		}
	}
	_, err = service.AcquireProductionCanvas(project.UserID, project.ID, unit.ID, AcquireProductionCanvasRequest{
		HumanConfirmed: true, ConfirmationID: "confirm-duplicate-001", ExpectedRevision: project.Revision, ExpectedContentHash: hash,
	})
	assertAppStatus(t, err, http.StatusConflict)
	if !strings.Contains(err.Error(), "legacy-a · legacy-b") {
		t.Fatalf("duplicate conflict did not list exact canvases: %v", err)
	}
	assertProductionCanvasCounts(t, db, project.ID, unit.ID, 2, 2)
	assertProjectRevision(t, db, project.ID, project.Revision)
}

func TestProductionRoleCannotBypassFormalEndpointOrProjectOwnership(t *testing.T) {
	service, db, project, unit := productionCanvasFixture(t)
	t.Setenv(productionCanvasWriteEnv, "true")
	foreignCanvas := model.CanvasProject{ID: "canvas-unassigned", UserID: project.UserID, Title: "待关联", PayloadJSON: `{}`, CreatedAt: project.CreatedAt, UpdatedAt: project.UpdatedAt}
	if err := db.Create(&foreignCanvas).Error; err != nil {
		t.Fatal(err)
	}
	_, err := service.LinkCanvasUnit(project.UserID, project.ID, LinkCanvasUnitRequest{CanvasID: foreignCanvas.ID, UnitID: unit.ID, Role: productionCanvasRole})
	assertAppStatus(t, err, http.StatusBadRequest)
	var stored model.CanvasProject
	if err := db.First(&stored, "id = ?", foreignCanvas.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.ProjectID != "" {
		t.Fatalf("generic endpoint partially assigned production canvas: %q", stored.ProjectID)
	}

	_, err = service.AcquireProductionCanvas("other-user", project.ID, unit.ID, AcquireProductionCanvasRequest{
		HumanConfirmed: true, ConfirmationID: "confirm-foreign-001", ExpectedRevision: project.Revision, ExpectedContentHash: hostUnitSourceHash(unit.SourceText),
	})
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("foreign ownership error = %v, want record not found", err)
	}
	assertProductionCanvasCounts(t, db, project.ID, unit.ID, 0, 0)
}

func TestAcquireProductionCanvasConcurrentRequestsReturnSameIdentity(t *testing.T) {
	service, db, project, unit := productionCanvasFixture(t)
	t.Setenv(productionCanvasWriteEnv, "true")
	dbSQL, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	dbSQL.SetMaxOpenConns(8)
	hash := hostUnitSourceHash(unit.SourceText)
	secondService := &Service{repo: repository.New(db)}
	services := []*Service{service, secondService}
	results := make([]ProductionCanvasResult, 2)
	errorsByIndex := make([]error, 2)
	start := make(chan struct{})
	var wait sync.WaitGroup
	for index := range results {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			<-start
			results[index], errorsByIndex[index] = services[index].AcquireProductionCanvas(project.UserID, project.ID, unit.ID, AcquireProductionCanvasRequest{
				HumanConfirmed: true, ConfirmationID: "confirm-concurrent-00" + string(rune('1'+index)), ExpectedRevision: project.Revision, ExpectedContentHash: hash,
			})
		}(index)
	}
	close(start)
	wait.Wait()
	for index, err := range errorsByIndex {
		if err != nil {
			t.Fatalf("request %d failed: %v", index, err)
		}
	}
	if results[0].Canvas.ID != results[1].Canvas.ID || results[0].Link.ID != results[1].Link.ID || results[0].AuditEventID != results[1].AuditEventID {
		t.Fatalf("concurrent identities diverged: %+v / %+v", results[0], results[1])
	}
	assertProductionCanvasCounts(t, db, project.ID, unit.ID, 1, 1)
	var guardCount, auditCount int64
	if err := db.Model(&model.ProductionCanvasGuard{}).Where("project_id = ? AND unit_id = ?", project.ID, unit.ID).Count(&guardCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.AdminAuditEvent{}).Where("action = ? AND target_id = ?", "production_canvas.acquire", results[0].Canvas.ID).Count(&auditCount).Error; err != nil {
		t.Fatal(err)
	}
	if guardCount != 1 || auditCount != 1 {
		t.Fatalf("guard/audit counts = %d/%d, want 1/1", guardCount, auditCount)
	}
}

func TestAcquireProductionCanvasAuditFailureRollsBackWithoutOrphan(t *testing.T) {
	service, db, project, unit := productionCanvasFixture(t)
	t.Setenv(productionCanvasWriteEnv, "true")
	if err := db.Exec(`CREATE TRIGGER fail_production_canvas_audit BEFORE INSERT ON admin_audit_events WHEN NEW.action = 'production_canvas.acquire' BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`).Error; err != nil {
		t.Fatal(err)
	}
	_, err := service.AcquireProductionCanvas(project.UserID, project.ID, unit.ID, AcquireProductionCanvasRequest{
		HumanConfirmed: true, ConfirmationID: "confirm-audit-failure", ExpectedRevision: project.Revision, ExpectedContentHash: hostUnitSourceHash(unit.SourceText),
	})
	if err == nil {
		t.Fatal("expected forced audit failure")
	}
	assertProductionCanvasCounts(t, db, project.ID, unit.ID, 0, 0)
	assertProjectRevision(t, db, project.ID, project.Revision)
	var guardCount int64
	if err := db.Model(&model.ProductionCanvasGuard{}).Where("project_id = ?", project.ID).Count(&guardCount).Error; err != nil || guardCount != 0 {
		t.Fatalf("orphan guard count = %d, error = %v", guardCount, err)
	}
}

func TestAcquireProductionCanvasReusesExistingAfterSourceChanges(t *testing.T) {
	service, db, project, unit := productionCanvasFixture(t)
	t.Setenv(productionCanvasWriteEnv, "true")
	created, err := service.AcquireProductionCanvas(project.UserID, project.ID, unit.ID, AcquireProductionCanvasRequest{
		HumanConfirmed: true, ConfirmationID: "confirm-source-v1", ExpectedRevision: project.Revision, ExpectedContentHash: hostUnitSourceHash(unit.SourceText),
	})
	if err != nil {
		t.Fatal(err)
	}
	unit.SourceText += "\n乙：我来了。"
	if err := db.Model(&model.ProjectUnit{}).Where("id = ?", unit.ID).Update("source_text", unit.SourceText).Error; err != nil {
		t.Fatal(err)
	}
	reused, err := service.AcquireProductionCanvas(project.UserID, project.ID, unit.ID, AcquireProductionCanvasRequest{
		HumanConfirmed: true, ConfirmationID: "confirm-source-v2", ExpectedRevision: project.Revision + 1, ExpectedContentHash: hostUnitSourceHash(unit.SourceText),
	})
	if err != nil {
		t.Fatal(err)
	}
	if reused.Canvas.ID != created.Canvas.ID || reused.Disposition != "reused" || reused.ObservedContentHash != hostUnitSourceHash(unit.SourceText) {
		t.Fatalf("source change did not reuse current Host identity: %+v", reused)
	}
}

func TestProductionCanvasRepositoryRechecksSourceHashInsideTransaction(t *testing.T) {
	service, db, project, unit := productionCanvasFixture(t)
	observedHash := hostUnitSourceHash(unit.SourceText)
	unit.SourceText += "\n事务前变更"
	if err := db.Model(&model.ProjectUnit{}).Where("id = ?", unit.ID).Update("source_text", unit.SourceText).Error; err != nil {
		t.Fatal(err)
	}
	now := project.CreatedAt
	canvasID, linkID, auditID := newID(), newID(), newID()
	_, err := service.repo.AcquireProductionCanvas(repository.ProductionCanvasAcquireInput{
		UserID: project.UserID, ProjectID: project.ID, UnitID: unit.ID, ExpectedRevision: project.Revision, ExpectedContentHash: observedHash,
		Canvas:     model.CanvasProject{ID: canvasID, UserID: project.UserID, ProjectID: project.ID, Title: "stale", PayloadJSON: `{}`, CreatedAt: now, UpdatedAt: now},
		Link:       model.CanvasUnitLink{ID: linkID, ProjectID: project.ID, CanvasID: canvasID, UnitID: unit.ID, Role: productionCanvasRole, CreatedAt: now},
		Guard:      model.ProductionCanvasGuard{ID: newID(), ProjectID: project.ID, UnitID: unit.ID, CanvasID: canvasID, LinkID: linkID, ConfirmationID: "confirm-stale-tx", ConfirmedByUserID: project.UserID, ObservedSourceHash: observedHash, AuditEventID: auditID, CreatedAt: now},
		AuditEvent: model.AdminAuditEvent{ID: auditID, ActorUserID: project.UserID, Action: "production_canvas.acquire", TargetType: "production_canvas", TargetID: canvasID, CreatedAt: now},
	})
	if !errors.Is(err, repository.ErrProductionCanvasContentHashConflict) {
		t.Fatalf("transaction hash guard error = %v", err)
	}
	assertProductionCanvasCounts(t, db, project.ID, unit.ID, 0, 0)
	assertProjectRevision(t, db, project.ID, project.Revision)
}

func TestDeleteProductionUnitRemovesGuardButKeepsAppendOnlyAudit(t *testing.T) {
	service, db, project, unit := productionCanvasFixture(t)
	t.Setenv(productionCanvasWriteEnv, "true")
	created, err := service.AcquireProductionCanvas(project.UserID, project.ID, unit.ID, AcquireProductionCanvasRequest{
		HumanConfirmed: true, ConfirmationID: "confirm-delete-unit", ExpectedRevision: project.Revision, ExpectedContentHash: hostUnitSourceHash(unit.SourceText),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteProjectUnit(project.UserID, project.ID, unit.ID); err != nil {
		t.Fatal(err)
	}
	var guardCount, auditCount int64
	if err := db.Model(&model.ProductionCanvasGuard{}).Where("unit_id = ?", unit.ID).Count(&guardCount).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.AdminAuditEvent{}).Where("id = ?", created.AuditEventID).Count(&auditCount).Error; err != nil {
		t.Fatal(err)
	}
	if guardCount != 0 || auditCount != 1 {
		t.Fatalf("post-delete guard/audit = %d/%d, want 0/1", guardCount, auditCount)
	}
}

func productionCanvasFixture(t *testing.T) (*Service, *gorm.DB, model.Project, model.ProjectUnit) {
	t.Helper()
	service, db := newProjectDeleteTestService(t)
	if err := db.AutoMigrate(&model.AdminAuditEvent{}, &model.ProductionCanvasGuard{}); err != nil {
		t.Fatal(err)
	}
	project := model.Project{ID: newID(), UserID: "user-production", Name: "Golden C", Status: model.ProjectStatusActive, Revision: 7}
	unit := model.ProjectUnit{ID: newID(), ProjectID: project.ID, Kind: model.ProjectUnitKindChapter, Title: "第一集", SourceText: "INT. 客厅 - 夜\n甲：你来了。"}
	if err := db.Create(&project).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&unit).Error; err != nil {
		t.Fatal(err)
	}
	return service, db, project, unit
}

func assertAppStatus(t *testing.T, err error, want int) {
	t.Helper()
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Status != want {
		t.Fatalf("error = %#v, want AppError status %d", err, want)
	}
}

func assertProductionCanvasCounts(t *testing.T, db *gorm.DB, projectID string, unitID string, wantCanvases int64, wantLinks int64) {
	t.Helper()
	var canvasCount int64
	if err := db.Model(&model.CanvasProject{}).Where("project_id = ?", projectID).Count(&canvasCount).Error; err != nil {
		t.Fatal(err)
	}
	var linkCount int64
	if err := db.Model(&model.CanvasUnitLink{}).Where("project_id = ? AND unit_id = ? AND role = ?", projectID, unitID, productionCanvasRole).Count(&linkCount).Error; err != nil {
		t.Fatal(err)
	}
	if canvasCount != wantCanvases || linkCount != wantLinks {
		t.Fatalf("counts = canvas %d, link %d; want %d, %d", canvasCount, linkCount, wantCanvases, wantLinks)
	}
}

func assertProjectRevision(t *testing.T, db *gorm.DB, projectID string, want int64) {
	t.Helper()
	var project model.Project
	if err := db.First(&project, "id = ?", projectID).Error; err != nil {
		t.Fatal(err)
	}
	if project.Revision != want {
		t.Fatalf("project revision = %d, want %d", project.Revision, want)
	}
}
