package service

import (
	"bytes"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const shotTestSource = "<p>场景：客厅，林夏在门旁。</p><p>林夏：我陪你。</p><p>动作：林夏关门。</p>"

func shotTestService(t *testing.T) (*Service, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "shots.db")+"?_busy_timeout=5000&_journal_mode=WAL"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	t.Cleanup(func() { _ = conn.Close() })
	if err := db.AutoMigrate(&model.Project{}, &model.ProjectUnit{}, &model.ProjectUnitRevision{}, &model.Shot{}, &model.ShotRevision{}, &model.ShotBatchReceipt{}, &model.ShotAssetReference{}, &model.ProjectAssetCandidate{}); err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.Project{ID: "p", UserID: "u", Name: "隔离分镜", Status: model.ProjectStatusActive, Revision: 1},
		&model.Project{ID: "foreign", UserID: "other", Name: "其他用户", Status: model.ProjectStatusActive, Revision: 1},
		&model.ProjectUnit{ID: "chapter", ProjectID: "p", Title: "客厅", SourceText: shotTestSource, Revision: 1, Status: model.ProjectUnitStatusDraft},
		&model.ProjectUnit{ID: "other-chapter", ProjectID: "p", Title: "客厅", SourceText: shotTestSource, Revision: 1, Status: model.ProjectUnitStatusDraft},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	return &Service{repo: repository.New(db)}, db
}

func shotTestRequest() SaveProjectUnitShotsRequest {
	zero := int64(0)
	return SaveProjectUnitShotsRequest{RequestID: "first", ExpectedShotRevision: &zero, SourceRevision: 1, SourceHash: repository.ScriptSourceHash(shotTestSource), SourceParagraphIDs: []string{"p0001", "p0002", "p0003"}, Shots: []ProjectShotWriteRequest{
		{Title: "林夏回应", Description: "林夏望向屋内", Position: 0, DurationMs: 5000, Content: model.ShotContent{Scene: "客厅", Characters: []string{"林夏"}, Action: "林夏望向屋内", Camera: "中景，门侧", SourceReferences: []model.ShotSourceReference{{ParagraphID: "p0001", Quote: "场景：客厅，林夏在门旁。"}, {ParagraphID: "p0002", Quote: "林夏：我陪你。"}}, Dialogue: []model.ShotDialogue{{Speaker: "林夏", Text: "我陪你。", ParagraphID: "p0002"}}}},
		{Title: "关门", Description: "林夏关门", Position: 1, DurationMs: 3000, Content: model.ShotContent{Scene: "客厅", Characters: []string{"林夏"}, Action: "林夏关门", Camera: "近景", SourceReferences: []model.ShotSourceReference{{ParagraphID: "p0003", Quote: "动作：林夏关门。"}}, Dialogue: []model.ShotDialogue{}}},
	}}
}

func requireShotConflict(t *testing.T, err error) {
	t.Helper()
	var app *AppError
	if !errors.As(err, &app) || app.Status != 409 {
		t.Fatalf("want conflict, got %v", err)
	}
}

// Compare every persisted field, not time.Time's process-local monotonic clock.
func equalShotJSON(t *testing.T, a, b any) bool {
	t.Helper()
	left, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	right, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.Equal(left, right)
}

func TestShotBatchSaveReadbackReplayAndLocalEdit(t *testing.T) {
	s, db := shotTestService(t)
	req := shotTestRequest()
	first, err := s.SaveProjectUnitShots("u", "p", "chapter", req)
	if err != nil {
		t.Fatal(err)
	}
	if first.Replayed || first.Receipt.ShotRevision != 1 || len(first.Receipt.Shots) != 2 {
		t.Fatalf("bad receipt: %+v", first)
	}
	replay, err := s.SaveProjectUnitShots("u", "p", "chapter", req)
	if err != nil || !replay.Replayed || !equalShotJSON(t, first.Receipt.Shots, replay.Receipt.Shots) {
		t.Fatalf("retry: %+v %v", replay, err)
	}
	shot := first.Receipt.Shots[0]
	if err := db.Create(&model.ShotAssetReference{ID: "ref", ShotID: shot.ID, AssetVersionID: "frozen-version", Role: "reference"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ProjectAssetCandidate{ID: "candidate", ProjectID: "p", UnitID: "chapter", ShotID: shot.ID, Name: "未采用素材"}).Error; err != nil {
		t.Fatal(err)
	}
	context, err := s.GetProjectShotContext("u", "p", "chapter")
	if err != nil {
		t.Fatal(err)
	}
	if len(context.Paragraphs) != 3 || len(context.StaleShotIDs) != 0 || context.Unit.ShotRevision != 1 {
		t.Fatalf("context: %+v", context)
	}
	edit := req
	edit.RequestID = "local-edit"
	edit.ExpectedShotRevision = &context.Unit.ShotRevision
	edit.Shots = append([]ProjectShotWriteRequest{}, req.Shots[:1]...)
	edit.Shots[0].ID = shot.ID
	edit.Shots[0].ExpectedRevision = 1
	edit.Shots[0].Content.Camera = "近景，保持门侧方位"
	second, err := s.SaveProjectUnitShots("u", "p", "chapter", edit)
	if err != nil {
		t.Fatal(err)
	}
	if second.Receipt.Shots[0].ID != shot.ID || second.Receipt.Shots[0].Revision != 2 {
		t.Fatal("unstable shot identity")
	}
	rows, err := s.GetProjectShotRevisions("u", "p", shot.ID)
	if err != nil || len(rows) != 2 || rows[1].Snapshot.Content.Camera != "中景，门侧" {
		t.Fatalf("history: %+v %v", rows, err)
	}
	for _, row := range rows {
		body, _ := json.Marshal(row.Snapshot)
		if repository.ScriptSourceHash(string(body)) != row.ContentHash {
			t.Fatal("history hash mismatch")
		}
	}
	context, err = s.GetProjectShotContext("u", "p", "chapter")
	if err != nil {
		t.Fatal(err)
	}
	if !equalShotJSON(t, context.Shots[1], first.Receipt.Shots[1]) {
		t.Fatal("unrelated shot changed")
	}
	if !equalShotJSON(t, context.Shots[0], second.Receipt.Shots[0]) {
		t.Fatal("receipt is not the exact persisted updated shot")
	}
	for _, row := range []any{&model.ShotAssetReference{}, &model.ProjectAssetCandidate{}} {
		var count int64
		db.Model(row).Count(&count)
		if count != 1 {
			t.Fatal("lost reference/candidate")
		}
	}
	// An old successful request remains identifiable after later edits.
	replay, err = s.SaveProjectUnitShots("u", "p", "chapter", req)
	if err != nil || !replay.Replayed || replay.Receipt.Shots[0].Revision != 1 {
		t.Fatalf("historical retry: %+v %v", replay, err)
	}
	context, _ = s.GetProjectShotContext("u", "p", "chapter")
	if context.Shots[0].Revision != 2 {
		t.Fatal("retry reverted current shot")
	}
}

func TestShotSourceCharacterIdentityAndScreenPresenceAreSeparate(t *testing.T) {
	paragraphs := scriptParagraphs("<p>场景：控制室。屏幕上，阿禾的影像旁显示索恩的胸甲标记。</p>")
	content := model.ShotContent{
		Scene: "控制室", Characters: []string{"阿禾", "索恩"},
		SourceReferences: []model.ShotSourceReference{{ParagraphID: paragraphs[0].ID, Quote: paragraphs[0].Text}},
		Action: "阿禾仅为屏幕影像，索恩仅胸甲标记可见。", Camera: "屏幕特写，两人不在控制室现场。",
	}
	if err := validateShotContent(content, paragraphs); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"阿禾（仅屏幕影像）", "索恩（胸甲标记）", "虚构角色", "asset-123"} {
		content.Characters = []string{name}
		var app *AppError
		err := validateShotContent(content, paragraphs)
		if !errors.As(err, &app) || app.Status != 400 || !strings.Contains(err.Error(), "action/camera") {
			t.Fatalf("want actionable source rejection, got %v", err)
		}
	}
}

func TestShotBatchRejectsInvalidWholeBatchAndScope(t *testing.T) {
	for _, name := range []string{"bad-second", "source", "missing-version", "duplicate-position", "dialogue", "source-ref", "invented-character", "wrong-user", "wrong-unit"} {
		t.Run(name, func(t *testing.T) {
			s, db := shotTestService(t)
			req := shotTestRequest()
			user, unit := "u", "chapter"
			switch name {
			case "bad-second":
				req.Shots[1].Title = ""
			case "source":
				req.SourceHash = "bad"
			case "missing-version":
				req.ExpectedShotRevision = nil
			case "duplicate-position":
				req.Shots[1].Position = 0
			case "dialogue":
				req.Shots[0].Content.Dialogue[0].Text = "不存在的改写"
			case "source-ref":
				req.Shots[0].Content.SourceReferences[0].ParagraphID = "fake"
			case "invented-character":
				req.Shots[0].Content.Characters = []string{"张三"}
			case "wrong-user":
				user = "other"
			case "wrong-unit":
				unit = "missing"
			}
			if _, err := s.SaveProjectUnitShots(user, "p", unit, req); err == nil {
				t.Fatal("invalid request accepted")
			}
			for _, m := range []any{&model.Shot{}, &model.ShotRevision{}, &model.ShotBatchReceipt{}} {
				var count int64
				db.Model(m).Count(&count)
				if count != 0 {
					t.Fatal("partial writes")
				}
			}
			var actual model.ProjectUnit
			db.First(&actual, "id = ?", "chapter")
			if actual.ShotRevision != 0 {
				t.Fatal("version advanced on failure")
			}
		})
	}
}

func TestShotBatchManualConflictSourceStalenessAndRollback(t *testing.T) {
	s, db := shotTestService(t)
	req := shotTestRequest()
	first, err := s.SaveProjectUnitShots("u", "p", "chapter", req)
	if err != nil {
		t.Fatal(err)
	}
	shot := first.Receipt.Shots[0]
	manual, err := s.CreateProjectShot("u", "p", CreateProjectShotRequest{ID: shot.ID, UnitID: "chapter", Title: "手工改名", Description: shot.Description, Position: 0, DurationMs: 5000, ExpectedRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	if manual.Revision != 2 || !reflect.DeepEqual(manual.Content, shot.Content) {
		t.Fatal("manual edit lost creative fields")
	}
	_, err = s.CreateProjectShot("u", "p", CreateProjectShotRequest{ID: shot.ID, Title: "旧修改", ExpectedRevision: 1})
	requireShotConflict(t, err)
	req.RequestID = "stale"
	_, err = s.SaveProjectUnitShots("u", "p", "chapter", req)
	requireShotConflict(t, err)
	req.RequestID = "first"
	req.Shots[0].Title = "changed input"
	_, err = s.SaveProjectUnitShots("u", "p", "chapter", req)
	requireShotConflict(t, err)
	ctx, _ := s.GetProjectShotContext("u", "p", "chapter")
	req = shotTestRequest()
	req.RequestID = "rollback"
	req.ExpectedShotRevision = &ctx.Unit.ShotRevision
	req.Shots[0].ID = shot.ID
	req.Shots[0].ExpectedRevision = 2
	req.Shots[1].ID = first.Receipt.Shots[1].ID
	req.Shots[1].ExpectedRevision = 1
	if err := db.Exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON shot_batch_receipts BEGIN SELECT RAISE(ABORT, 'injected'); END").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveProjectUnitShots("u", "p", "chapter", req); err == nil {
		t.Fatal("injected failure ignored")
	}
	after, _ := s.GetProjectShotContext("u", "p", "chapter")
	if !reflect.DeepEqual(ctx.Shots, after.Shots) || after.Unit.ShotRevision != ctx.Unit.ShotRevision {
		t.Fatal("transaction did not roll back")
	}
	if _, err := s.ReviseProjectScript("u", "p", "chapter", UpdateProjectUnitRequest{ExpectedRevision: 1, RequestID: "source-change", SourceText: shotTestSource + "<p>动作：敲门。</p>"}); err != nil {
		t.Fatal(err)
	}
	after, _ = s.GetProjectShotContext("u", "p", "chapter")
	if len(after.StaleShotIDs) != 2 {
		t.Fatal("source change not marked stale")
	}
	_, err = s.SaveProjectUnitShots("u", "p", "chapter", req)
	requireShotConflict(t, err)
}

func TestShotBatchConcurrentConnections(t *testing.T) {
	for _, sameRequest := range []bool{true, false} {
		t.Run(map[bool]string{true: "identical-retry", false: "competing-edit"}[sameRequest], func(t *testing.T) {
			s, db := shotTestService(t)
			var file struct{ File string }
			if err := db.Raw("PRAGMA database_list").Scan(&file).Error; err != nil || file.File == "" {
				t.Fatalf("database path: %v", err)
			}
			other, err := gorm.Open(sqlite.Open(file.File+"?_busy_timeout=5000&_journal_mode=WAL"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
			if err != nil {
				t.Fatal(err)
			}
			conn, _ := other.DB()
			t.Cleanup(func() { _ = conn.Close() })
			services := []*Service{s, {repo: repository.New(other)}}
			requests := []SaveProjectUnitShotsRequest{shotTestRequest(), shotTestRequest()}
			if !sameRequest {
				requests[1].RequestID = "competing"
				requests[1].Shots[0].Title = "另一项修改"
			}
			start := make(chan struct{})
			errs := make([]error, 2)
			var wg sync.WaitGroup
			for i := range services {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					<-start
					_, errs[i] = services[i].SaveProjectUnitShots("u", "p", "chapter", requests[i])
				}(i)
			}
			close(start)
			wg.Wait()
			if errs[0] != nil && errs[1] != nil {
				t.Fatalf("no successful writer: %v", errs)
			}
			for i := range services {
				retry, err := services[i].SaveProjectUnitShots("u", "p", "chapter", requests[i])
				if sameRequest || errs[i] == nil {
					if err != nil || !retry.Replayed || retry.Receipt.ShotRevision != 1 {
						t.Fatalf("cannot identify committed request: %+v %v", retry, err)
					}
				} else {
					requireShotConflict(t, err)
				}
			}
			for _, check := range []struct {
				value any
				want  int64
			}{{&model.Shot{}, 2}, {&model.ShotRevision{}, 2}, {&model.ShotBatchReceipt{}, 1}} {
				var count int64
				if err := db.Model(check.value).Count(&count).Error; err != nil || count != check.want {
					t.Fatalf("duplicate/partial write: %T %d %v", check.value, count, err)
				}
			}
		})
	}
}

func TestShotBatchFrozenStateAndManualPosition(t *testing.T) {
	for _, state := range []string{"archived-project", "completed-unit", "completed-shot", "foreign-shot", "other-unit-shot", "occupied-position"} {
		t.Run(state, func(t *testing.T) {
			s, db := shotTestService(t)
			first, err := s.SaveProjectUnitShots("u", "p", "chapter", shotTestRequest())
			if err != nil {
				t.Fatal(err)
			}
			req := shotTestRequest()
			req.RequestID = "edit"
			one := int64(1)
			req.ExpectedShotRevision = &one
			for i := range req.Shots {
				req.Shots[i].ID, req.Shots[i].ExpectedRevision = first.Receipt.Shots[i].ID, 1
			}
			shotID := req.Shots[0].ID
			switch state {
			case "archived-project":
				db.Model(&model.Project{}).Where("id = ?", "p").Update("status", "archived")
			case "completed-unit":
				db.Model(&model.ProjectUnit{}).Where("id = ?", "chapter").Update("status", "completed")
			case "completed-shot":
				db.Model(&model.Shot{}).Where("id = ?", shotID).Update("status", "completed")
			case "foreign-shot":
				db.Model(&model.Shot{}).Where("id = ?", shotID).Update("project_id", "foreign")
			case "other-unit-shot":
				db.Model(&model.Shot{}).Where("id = ?", shotID).Update("unit_id", "other-chapter")
			case "occupied-position":
				_, err = s.CreateProjectShot("u", "p", CreateProjectShotRequest{ID: shotID, ExpectedRevision: 1, Title: "撞序号", Position: 1})
				requireShotConflict(t, err)
				return
			}
			if _, err := s.SaveProjectUnitShots("u", "p", "chapter", req); err == nil {
				t.Fatal("frozen/scope boundary bypassed")
			}
			var count int64
			db.Model(&model.ShotBatchReceipt{}).Count(&count)
			if count != 1 {
				t.Fatal("failed request persisted")
			}
			if state == "completed-unit" || state == "archived-project" {
				_, err := s.CreateProjectShot("u", "p", CreateProjectShotRequest{ID: shotID, ExpectedRevision: 1, Title: "绕过批量写入"})
				requireShotConflict(t, err)
			}
		})
	}
}
