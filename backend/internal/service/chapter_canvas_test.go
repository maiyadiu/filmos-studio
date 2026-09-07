package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func chapterCanvasFixture(t *testing.T) (*Service, *gorm.DB, model.Project, model.ProjectUnit) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "chapter.db")+"?_busy_timeout=5000&_journal_mode=WAL"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(database.Models()...); err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	t.Cleanup(func() { _ = conn.Close() })
	p := model.Project{ID: newID(), UserID: "chapter-owner", Name: "作品", Status: model.ProjectStatusActive, Revision: 1}
	u := model.ProjectUnit{ID: newID(), ProjectID: p.ID, Kind: model.ProjectUnitKindChapter, Title: "第一章", SourceText: "<p>旧稿必须保留。</p>"}
	if err := db.Create(&p).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&u).Error; err != nil {
		t.Fatal(err)
	}
	return &Service{repo: repository.New(db)}, db, p, u
}

func TestChapterCanvasMigrationPreservesLegacyWork(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "legacy.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	conn, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	// This is the pre-change chapter schema, not a new schema with a NULL
	// inserted after migration. Both old chapters must remain unbound.
	if err := db.Exec(`CREATE TABLE project_units (id text PRIMARY KEY, project_id text, kind text, title text, status text, revision integer, shot_revision integer, source_text text, position integer, created_at datetime, updated_at datetime)`).Error; err != nil {
		t.Fatal(err)
	}
	for i, id := range []string{"old-unit-a", "old-unit-b"} {
		if err := db.Exec(`INSERT INTO project_units (id, project_id, kind, title, status, revision, shot_revision, source_text, position) VALUES (?, 'old-project', 'chapter', ?, 'ready', 3, 2, ?, ?)`, id, id, "<p>完整旧稿，包含对白。</p>", i).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.AutoMigrate(&model.CanvasProject{}, &model.CanvasUnitLink{}, &model.ProjectUnitRevision{}); err != nil {
		t.Fatal(err)
	}
	canvas := model.CanvasProject{ID: "legacy-canvas", UserID: "owner", ProjectID: "old-project", PayloadJSON: `{"nodes":[{"id":"old-image","url":"/resource/keep"}],"connections":[]}`}
	link := model.CanvasUnitLink{ID: "legacy-link", ProjectID: "old-project", UnitID: "old-unit-a", CanvasID: canvas.ID, Role: "storyboard"}
	history := model.ProjectUnitRevision{ID: "legacy-history", ProjectID: "old-project", UnitID: "old-unit-a", Revision: 1, SourceText: "<p>初稿保留</p>", RequestID: "legacy-request"}
	for _, row := range []any{&canvas, &link, &history} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.AutoMigrate(database.Models()...); err != nil {
		t.Fatal(err)
	}
	var units []model.ProjectUnit
	if err := db.Order("position").Find(&units).Error; err != nil {
		t.Fatal(err)
	}
	if len(units) != 2 {
		t.Fatal(units)
	}
	for _, unit := range units {
		if unit.ChapterCanvasID != nil || unit.Revision != 3 || unit.ShotRevision != 2 || unit.SourceText != "<p>完整旧稿，包含对白。</p>" {
			t.Fatalf("migration modified chapter: %+v", unit)
		}
	}
	var saved model.CanvasProject
	if err := db.First(&saved, "id = ?", canvas.ID).Error; err != nil || saved.PayloadJSON != canvas.PayloadJSON {
		t.Fatal("legacy canvas changed", err)
	}
	var savedHistory model.ProjectUnitRevision
	if err := db.First(&savedHistory, "id = ?", history.ID).Error; err != nil || savedHistory.SourceText != history.SourceText {
		t.Fatal("legacy history changed", err)
	}
	var savedLink model.CanvasUnitLink
	if err := db.First(&savedLink, "id = ?", link.ID).Error; err != nil || savedLink.CanvasID != canvas.ID {
		t.Fatal("legacy link changed", err)
	}
	if err := db.Model(&model.ProjectUnit{}).Where("id = ?", units[0].ID).UpdateColumn("chapter_canvas_id", canvas.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(database.Models()...); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.ProjectUnit{}).Where("id = ?", units[1].ID).UpdateColumn("chapter_canvas_id", canvas.ID).Error; err == nil {
		t.Fatal("unique canvas constraint absent after repeat migration")
	}
}

func TestChapterCanvasConcurrentAcquireAndDeleteRecreate(t *testing.T) {
	s, db, p, u := chapterCanvasFixture(t)
	const n = 12
	ids, errs := make(chan string, n), make(chan error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Distinct service instances: a process mutex is not the proof.
			other := &Service{repo: repository.New(db)}
			r, err := other.AcquireChapterCanvas(p.UserID, p.ID, u.ID, AcquireChapterCanvasRequest{})
			if err != nil {
				errs <- err
				return
			}
			ids <- r.Canvas.ID
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	first := ""
	for id := range ids {
		if first == "" {
			first = id
		}
		if id != first {
			t.Fatal("duplicate canvas", first, id)
		}
	}
	var count int64
	db.Model(&model.CanvasProject{}).Count(&count)
	if count != 1 {
		t.Fatal(count)
	}
	got, err := s.repo.ProjectUnit(p.ID, u.ID)
	if err != nil || got.ChapterCanvasID == nil || *got.ChapterCanvasID != first || got.SourceText != u.SourceText || got.Revision != u.Revision {
		t.Fatalf("chapter changed: %+v %v", got, err)
	}
	assertAppStatus(t, s.UnlinkCanvasUnit(p.UserID, p.ID, first, u.ID), 409)
	assertAppStatus(t, s.UnlinkCanvasProject(p.UserID, p.ID, first), 409)
	if err := s.repo.DeleteCanvasProject(p.UserID, first); err != nil {
		t.Fatal(err)
	}
	r, err := s.AcquireChapterCanvas(p.UserID, p.ID, u.ID, AcquireChapterCanvasRequest{})
	if err != nil || r.Canvas == nil || r.Canvas.ID == first {
		t.Fatalf("recreate: %+v %v", r, err)
	}
	got, _ = s.repo.ProjectUnit(p.ID, u.ID)
	if got.SourceText != u.SourceText || got.Revision != u.Revision {
		t.Fatal("recreate changed script")
	}
}

func TestChapterCanvasLegacySelectionPreservesAllContent(t *testing.T) {
	s, db, p, u := chapterCanvasFixture(t)
	for _, id := range []string{"old-a", "old-b"} {
		canvas := model.CanvasProject{ID: id, UserID: p.UserID, ProjectID: p.ID, Title: id, PayloadJSON: fmt.Sprintf(`{"id":%q,"projectId":%q,"nodes":[{"id":"keep"}]}`, id, p.ID)}
		if err := db.Create(&canvas).Error; err != nil {
			t.Fatal(err)
		}
		link := model.CanvasUnitLink{ID: newID(), ProjectID: p.ID, UnitID: u.ID, CanvasID: id, Role: "storyboard"}
		if err := db.Create(&link).Error; err != nil {
			t.Fatal(err)
		}
	}
	r, err := s.AcquireChapterCanvas(p.UserID, p.ID, u.ID, AcquireChapterCanvasRequest{})
	if err != nil || r.Disposition != "selection_required" || r.Canvas != nil || len(r.Candidates) != 2 {
		t.Fatalf("selection %+v %v", r, err)
	}
	r, err = s.AcquireChapterCanvas(p.UserID, p.ID, u.ID, AcquireChapterCanvasRequest{CanvasID: "old-b"})
	if err != nil || r.Canvas.ID != "old-b" || r.Disposition != "adopted" {
		t.Fatalf("adoption %+v %v", r, err)
	}
	_, err = s.AcquireChapterCanvas(p.UserID, p.ID, u.ID, AcquireChapterCanvasRequest{CanvasID: "old-a"})
	assertAppStatus(t, err, 409)
	r, err = s.AcquireChapterCanvas(p.UserID, p.ID, u.ID, AcquireChapterCanvasRequest{})
	if err != nil || r.Canvas.ID != "old-b" {
		t.Fatal("not sticky", err)
	}
	for _, id := range []string{"old-a", "old-b"} {
		c, err := s.repo.CanvasProjectForUser(p.UserID, id)
		if err != nil || c.PayloadJSON != fmt.Sprintf(`{"id":%q,"projectId":%q,"nodes":[{"id":"keep"}]}`, id, p.ID) {
			t.Fatal("legacy overwritten", id, err)
		}
	}
	var count int64
	db.Model(&model.CanvasProject{}).Count(&count)
	if count != 2 {
		t.Fatal(count)
	}
}

func TestChapterCanvasRejectsInconsistentLegacyPayloadWithoutBinding(t *testing.T) {
	s, db, p, u := chapterCanvasFixture(t)
	c := model.CanvasProject{ID: "bad-legacy", UserID: p.UserID, ProjectID: p.ID, PayloadJSON: `{"id":"bad-legacy","projectId":"other","nodes":[{"id":"keep"}]}`}
	l := model.CanvasUnitLink{ID: newID(), ProjectID: p.ID, UnitID: u.ID, CanvasID: c.ID, Role: "storyboard"}
	for _, row := range []any{&c, &l} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	_, err := s.AcquireChapterCanvas(p.UserID, p.ID, u.ID, AcquireChapterCanvasRequest{})
	assertAppStatus(t, err, 409)
	unit, err := s.repo.ProjectUnit(p.ID, u.ID)
	if err != nil || unit.ChapterCanvasID != nil {
		t.Fatal("inconsistent canvas was bound", err)
	}
	canvas, err := s.repo.CanvasProjectForUser(p.UserID, c.ID)
	if err != nil || canvas.PayloadJSON != c.PayloadJSON {
		t.Fatal("legacy content rewritten", err)
	}
}

func TestChapterCanvasScopeAndOtherMutationPaths(t *testing.T) {
	s, db, p, u := chapterCanvasFixture(t)
	_, err := s.AcquireChapterCanvas("intruder", p.ID, u.ID, AcquireChapterCanvasRequest{})
	if !IsProjectNotFound(err) {
		t.Fatal("scope", err)
	}
	_, err = s.AcquireChapterCanvas(p.UserID, p.ID, "missing", AcquireChapterCanvasRequest{})
	if !IsProjectNotFound(err) {
		t.Fatal("unit scope", err)
	}
	r, err := s.AcquireChapterCanvas(p.UserID, p.ID, u.ID, AcquireChapterCanvasRequest{})
	if err != nil {
		t.Fatal(err)
	}
	c := *r.Canvas
	u2 := model.ProjectUnit{ID: newID(), ProjectID: p.ID, Title: "第二章"}
	db.Create(&u2)
	_, err = s.LinkCanvasUnit(p.UserID, p.ID, LinkCanvasUnitRequest{CanvasID: c.ID, UnitID: u2.ID})
	assertAppStatus(t, err, 409)
	other := model.CanvasProject{ID: "other", UserID: p.UserID, ProjectID: p.ID, PayloadJSON: `{"nodes":[]}`}
	db.Create(&other)
	_, err = s.LinkCanvasUnit(p.UserID, p.ID, LinkCanvasUnitRequest{CanvasID: other.ID, UnitID: u.ID})
	assertAppStatus(t, err, 409)
	c.ProjectID = "other-project"
	if err := s.repo.UpsertCanvasProject(&c); !errors.Is(err, repository.ErrChapterCanvasBinding) {
		t.Fatal("upsert reassigned", err)
	}
	if err := s.repo.AssignCanvasToProject(p.UserID, c.ID, "other-project"); !errors.Is(err, repository.ErrChapterCanvasBinding) {
		t.Fatal("assign reassigned", err)
	}
	if err := s.repo.ReplaceCanvasProjects(p.UserID, []model.CanvasProject{other}); !errors.Is(err, repository.ErrChapterCanvasBinding) {
		t.Fatal("bulk erased", err)
	}
	if err := s.repo.ReplaceCanvasProjects(p.UserID, []model.CanvasProject{c, other}); !errors.Is(err, repository.ErrChapterCanvasBinding) {
		t.Fatal("bulk reassigned", err)
	}
	current, _ := s.repo.CanvasProjectForUser(p.UserID, c.ID)
	if current.ProjectID != p.ID {
		t.Fatal("partial reassignment")
	}
}

func TestChapterCanvasArchivedAndCreationFailureAreAtomic(t *testing.T) {
	s, db, p, u := chapterCanvasFixture(t)
	db.Model(&p).Update("status", model.ProjectStatusArchived)
	_, err := s.AcquireChapterCanvas(p.UserID, p.ID, u.ID, AcquireChapterCanvasRequest{})
	assertAppStatus(t, err, 409)
	db.Model(&p).Update("status", model.ProjectStatusActive)
	if err := db.Exec("CREATE TRIGGER reject_chapter_link BEFORE INSERT ON canvas_unit_links BEGIN SELECT RAISE(ABORT, 'fixture link failure'); END;").Error; err != nil {
		t.Fatal(err)
	}
	_, err = s.AcquireChapterCanvas(p.UserID, p.ID, u.ID, AcquireChapterCanvasRequest{})
	if err == nil {
		t.Fatal("expected failure")
	}
	var count int64
	db.Model(&model.CanvasProject{}).Count(&count)
	if count != 0 {
		t.Fatal("orphan", count)
	}
	got, _ := s.repo.ProjectUnit(p.ID, u.ID)
	if got.ChapterCanvasID != nil {
		t.Fatal("partial pointer")
	}
	assertProjectRevision(t, db, p.ID, p.Revision)
}

func TestChapterCanvasQuotaAndFormalEndpointDoNotBypassBinding(t *testing.T) {
	s, db, p, u := chapterCanvasFixture(t)
	policy := defaultRuntimePolicy()
	policy.Resource.CanvasCount = 1
	raw, _ := json.Marshal(policy)
	if err := db.Create(&model.SystemSetting{Key: runtimePolicySettingKey, ValueJSON: string(raw)}).Error; err != nil {
		t.Fatal(err)
	}
	r, err := s.AcquireChapterCanvas(p.UserID, p.ID, u.ID, AcquireChapterCanvasRequest{})
	if err != nil {
		t.Fatal(err)
	}
	u2 := model.ProjectUnit{ID: newID(), ProjectID: p.ID, Kind: model.ProjectUnitKindChapter, Title: "第二章"}
	if err := db.Create(&u2).Error; err != nil {
		t.Fatal(err)
	}
	_, err = s.AcquireChapterCanvas(p.UserID, p.ID, u2.ID, AcquireChapterCanvasRequest{})
	if err == nil {
		t.Fatal("quota bypass")
	}
	reused, err := s.AcquireChapterCanvas(p.UserID, p.ID, u.ID, AcquireChapterCanvasRequest{})
	if err != nil || reused.Canvas.ID != r.Canvas.ID {
		t.Fatal("quota should not block reuse", err)
	}
	t.Setenv(productionCanvasWriteEnv, "true")
	current, _ := s.repo.ProjectForUser(p.UserID, p.ID)
	_, err = s.AcquireProductionCanvas(p.UserID, p.ID, u.ID, AcquireProductionCanvasRequest{HumanConfirmed: true, ConfirmationID: "fixture-formal-request", ExpectedRevision: current.Revision, ExpectedContentHash: hostUnitSourceHash(u.SourceText)})
	assertAppStatus(t, err, 409)
	var count int64
	db.Model(&model.CanvasProject{}).Count(&count)
	if count != 1 {
		t.Fatal("second canvas", count)
	}
}
