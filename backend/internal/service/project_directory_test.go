package service

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/projectfs"
	"infinite-canvas/backend/internal/repository"
)

func TestProjectDirectoryAgentPromptContractUsesSameFiles(t *testing.T) {
	s, db, target := promptTestService(t)
	s.runtimeCapabilities = RuntimeCapabilitiesForDeployment("127.0.0.1:43101", "false", "true")
	s.dataDir = t.TempDir()
	parent := t.TempDir()
	parent, _ = filepath.EvalSymlinks(parent)
	path := filepath.Join(parent, "原生创作")
	if err := projectfs.Initialize(parent, "原生创作", "p", "原生创作", false); err != nil {
		t.Fatal(err)
	}
	row := model.ProjectDirectory{ProjectID: "p", UserID: "u", RequestID: "fixture-only", RootPath: path, State: "pending"}
	if err := db.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.SyncProjectDirectory("u", "p"); err != nil {
		t.Fatal(err)
	}
	req := promptSaveRequest(t, s, target, "directory-prompt")
	saved, err := s.SaveCanvasPrompt("u", "c", req)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := s.SaveCanvasPrompt("u", "c", req)
	if err != nil || !replayed.Replayed || saved.Receipt.ID != replayed.Receipt.ID {
		t.Fatal("prompt replay mismatch", err)
	}
	key := safeDirectoryID("c:n:" + target.RowID + ":image")
	b, err := os.ReadFile(filepath.Join(path, "提示词", key+".md"))
	if err != nil || string(b) != req.Prompt {
		t.Fatal("prompt not saved", err)
	}
	b, err = os.ReadFile(filepath.Join(path, "剧本", "chapter.html"))
	if err != nil || string(b) != shotTestSource {
		t.Fatal("source changed", err)
	}
	exported, err := s.ExportProjectDirectory("u", "p")
	if err != nil || filepath.Dir(exported.Path) != filepath.Join(path, "导出") {
		t.Fatal(exported, err)
	}
}

func TestProjectDirectoryExpiredSelectionRejected(t *testing.T) {
	s, _, _ := directoryServiceFixture(t)
	choice, err := s.ChooseProjectDirectory(context.Background(), "local-user")
	if err != nil {
		t.Fatal(err)
	}
	grant := s.projectDirectoryGrants[choice.LocationToken]
	grant.ExpiresAt = time.Now().Add(-time.Minute)
	s.projectDirectoryGrants[choice.LocationToken] = grant
	if _, err = s.CreateProject("local-user", CreateProjectRequest{Name: "不能落盘", LocalDirectory: &CreateProjectDirectoryRequest{RequestID: "expired", LocationToken: choice.LocationToken}}); err == nil {
		t.Fatal("expired token accepted")
	}
}

func TestProjectDirectoryValidationBeforeMutationAndGrantIdentity(t *testing.T) {
	s, db, n := directoryServiceFixture(t)
	for _, req := range []CreateProjectRequest{
		{Name: "../非法", LocalDirectory: &CreateProjectDirectoryRequest{RequestID: "bad-name"}},
		{Name: "坏画风", StyleProfileJSON: "not-json", LocalDirectory: &CreateProjectDirectoryRequest{RequestID: "bad-style"}},
	} {
		if _, err := s.CreateProject("local-user", req); err == nil {
			t.Fatal("invalid request accepted")
		}
	}
	var count int64
	db.Model(&model.ProjectDirectory{}).Count(&count)
	if count != 0 {
		t.Fatal("invalid request reserved a directory")
	}
	entries, _ := os.ReadDir(n.downloads)
	if len(entries) != 0 {
		t.Fatal("invalid request changed downloads")
	}
	choice, err := s.ChooseProjectDirectory(context.Background(), "local-user")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(n.selected, n.selected+"-original"); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(n.selected, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateProject("local-user", CreateProjectRequest{Name: "替换路径", LocalDirectory: &CreateProjectDirectoryRequest{RequestID: "replaced", LocationToken: choice.LocationToken}}); err == nil {
		t.Fatal("replaced grant target accepted")
	}
}

func TestProjectDirectorySharedAssetMediaAndCanvasReassignment(t *testing.T) {
	s, db, _ := directoryServiceFixture(t)
	projects := []model.Project{}
	for _, name := range []string{"甲作品", "乙作品"} {
		p, err := s.CreateProject("local-user", CreateProjectRequest{Name: name, LocalDirectory: &CreateProjectDirectoryRequest{RequestID: name}})
		if err != nil {
			t.Fatal(err)
		}
		projects = append(projects, p)
	}
	media := []byte("owned fixture media")
	if err := os.Mkdir(filepath.Join(s.dataDir, "resources"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.dataDir, "resources", "fixture.png"), media, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Resource{ID: "fixture-image", UserID: "local-user", Provider: "local", Kind: "image", ObjectKey: "fixture.png", Size: int64(len(media)), Status: model.ResourceStatusReady}).Error; err != nil {
		t.Fatal(err)
	}
	raw := json.RawMessage(`{"id":"shared","kind":"image","title":"共享素材","data":{"storageKey":"resource:fixture-image"},"metadata":{"apiKey":"fixture-secret"}}`)
	if _, err := s.UpsertUserAsset("local-user", raw); err != nil {
		t.Fatal(err)
	}
	for _, p := range projects {
		if _, err := s.LinkProjectAsset("local-user", p.ID, LinkProjectAssetRequest{AssetID: "shared"}); err != nil {
			t.Fatal(err)
		}
	}
	updated := json.RawMessage(strings.Replace(string(raw), "共享素材", "共享修订", 1))
	if _, err := s.UpsertUserAsset("local-user", updated); err != nil {
		t.Fatal(err)
	}
	for _, p := range projects {
		state, err := s.ProjectDirectoryStatus("local-user", p.ID)
		if err != nil || state.State != "ready" {
			t.Fatal(state, err)
		}
		b, err := os.ReadFile(filepath.Join(state.Path, "素材/文件-fixture-image.png"))
		if err != nil || string(b) != string(media) {
			t.Fatal("missing media", err)
		}
		b, err = os.ReadFile(filepath.Join(state.Path, "设定/素材-shared.json"))
		if err != nil || !strings.Contains(string(b), "共享修订") || strings.Contains(string(b), "fixture-secret") {
			t.Fatal("asset projection wrong", err)
		}
	}
	canvas := func(id string) json.RawMessage {
		b, _ := json.Marshal(map[string]any{"id": "canvas-one", "projectId": id, "nodes": []any{}})
		return b
	}
	if _, err := s.UpsertUserCanvasProject("local-user", canvas(projects[0].ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertUserCanvasProject("local-user", canvas(projects[1].ID)); err != nil {
		t.Fatal(err)
	}
	first, _ := s.ProjectDirectoryStatus("local-user", projects[0].ID)
	r, manifest, err := projectfs.Open(first.Path, projects[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	r.Close()
	for _, current := range manifest.CurrentFiles {
		if current == "分镜/画布-canvas-one.json" {
			t.Fatal("old project still lists canvas current")
		}
	}
	second, _ := s.ProjectDirectoryStatus("local-user", projects[1].ID)
	if err := os.Rename(second.Path, second.Path+"-offline"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertUserAsset("local-user", raw); err == nil {
		t.Fatal("shared offline write accepted")
	}
	current, _ := s.repo.AssetForUser("local-user", "shared")
	if current.Title != "共享修订" {
		t.Fatal("offline write changed DB")
	}
}

type directoryNativeFixture struct{ downloads, selected, opened string }

func (n *directoryNativeFixture) Downloads(context.Context) (string, error) { return n.downloads, nil }
func (n *directoryNativeFixture) Choose(context.Context, bool) (string, error) {
	return n.selected, nil
}
func (n *directoryNativeFixture) Open(_ context.Context, path string) error {
	n.opened = path
	return nil
}

func directoryServiceFixture(t *testing.T) (*Service, *gorm.DB, *directoryNativeFixture) {
	t.Helper()
	data := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(data, "test.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(database.Models()...); err != nil {
		t.Fatal(err)
	}
	conn, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	user := model.User{ID: "local-user", Username: "test", Role: model.UserRoleAdmin, Status: model.UserStatusActive}
	if err = db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	s := NewWithRuntimeCapabilities(repository.New(db), data, RuntimeCapabilitiesForDeployment("127.0.0.1:43101", "false", "true"))
	n := &directoryNativeFixture{downloads: t.TempDir(), selected: t.TempDir()}
	n.downloads, _ = filepath.EvalSymlinks(n.downloads)
	n.selected, _ = filepath.EvalSymlinks(n.selected)
	s.projectDirectoryNative = n
	return s, db, n
}

func TestProjectDirectoryDefaultCreationReplayAndOffline(t *testing.T) {
	s, db, n := directoryServiceFixture(t)
	location, err := s.ProjectDirectoryLocation(context.Background(), "local-user")
	if err != nil {
		t.Fatal(err)
	}
	if location.DefaultParent != n.downloads {
		t.Fatal(location)
	}
	if entries, e := os.ReadDir(location.DefaultParent); e != nil || len(entries) != 0 {
		t.Fatal("read-only location changed directory")
	}
	req := CreateProjectRequest{Name: "雨夜", LocalDirectory: &CreateProjectDirectoryRequest{RequestID: "create-1"}}
	a, err := s.CreateProject("local-user", req)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.CreateProject("local-user", req)
	if err != nil || a.ID != b.ID {
		t.Fatal(b, err)
	}
	var count int64
	db.Model(&model.Project{}).Count(&count)
	if count != 1 {
		t.Fatal(count)
	}
	status, err := s.ProjectDirectoryStatus("local-user", a.ID)
	if err != nil || status.State != "ready" {
		t.Fatal(status, err)
	}
	if _, err = os.Stat(filepath.Join(status.Path, "设定", "项目.json")); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(status.Path, status.Path+"-offline"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.CreateProject("local-user", req); err == nil {
		t.Fatal("offline project was recreated")
	}
	if _, err = os.Stat(status.Path); !os.IsNotExist(err) {
		t.Fatal("fallback directory created")
	}
}

func TestProjectDirectorySelectionScopeAndDefaultIsolation(t *testing.T) {
	s, _, n := directoryServiceFixture(t)
	choice, err := s.ChooseProjectDirectory(context.Background(), "local-user")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetDefaultProjectDirectory(context.Background(), "other-user", choice.LocationToken); err == nil {
		t.Fatal("cross-user token accepted")
	}
	if _, err = s.SetDefaultProjectDirectory(context.Background(), "local-user", choice.LocationToken); err != nil {
		t.Fatal(err)
	}
	location, err := s.ProjectDirectoryLocation(context.Background(), "local-user")
	if err != nil || location.DefaultParent != n.selected {
		t.Fatal(location, err)
	}
	req := CreateProjectRequest{Name: "中文 空格", LocalDirectory: &CreateProjectDirectoryRequest{RequestID: "create-custom", LocationToken: choice.LocationToken}}
	p, err := s.CreateProject("local-user", req)
	if err != nil {
		t.Fatal(err)
	}
	status, err := s.ProjectDirectoryStatus("local-user", p.ID)
	if err != nil || filepath.Dir(status.Path) != n.selected {
		t.Fatal(status, err)
	}
	n.selected = ""
	cancelled, err := s.ChooseProjectDirectory(context.Background(), "local-user")
	if err != nil || !cancelled.Cancelled {
		t.Fatal(cancelled, err)
	}
	before := status.Path
	n.selected = t.TempDir()
	next, err := s.ChooseProjectDirectory(context.Background(), "local-user")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetDefaultProjectDirectory(context.Background(), "local-user", next.LocationToken); err != nil {
		t.Fatal(err)
	}
	status, err = s.ProjectDirectoryStatus("local-user", p.ID)
	if err != nil || status.Path != before {
		t.Fatal("default change moved project", err)
	}
}

func TestProjectDirectoryPublicDeploymentRejectsLocalCreation(t *testing.T) {
	s, _, _ := directoryServiceFixture(t)
	s.runtimeCapabilities = RuntimeCapabilities{}
	if _, err := s.CreateProject("local-user", CreateProjectRequest{Name: "x", LocalDirectory: &CreateProjectDirectoryRequest{RequestID: "x"}}); err == nil {
		t.Fatal("public filesystem creation allowed")
	}
	location, err := s.ProjectDirectoryLocation(context.Background(), "local-user")
	if err != nil || location.Enabled {
		t.Fatal(location, err)
	}
}

func TestProjectDirectoryScriptWriteAndRelocatePreserveIdentity(t *testing.T) {
	s, _, n := directoryServiceFixture(t)
	p, err := s.CreateProject("local-user", CreateProjectRequest{Name: "读写核验", LocalDirectory: &CreateProjectDirectoryRequest{RequestID: "script-project"}})
	if err != nil {
		t.Fatal(err)
	}
	u, err := s.CreateProjectUnit("local-user", p.ID, CreateProjectUnitRequest{Title: "第一章", Kind: "chapter", SourceText: "旧对白"})
	if err != nil {
		t.Fatal(err)
	}
	edit := UpdateProjectUnitRequest{ExpectedRevision: u.Revision, RequestID: "revision-1", SourceText: "新对白"}
	if _, err = s.ReviseProjectScript("local-user", p.ID, u.ID, edit); err != nil {
		t.Fatal(err)
	}
	status, err := s.ProjectDirectoryStatus("local-user", p.ID)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(status.Path, "剧本", u.ID+".md"))
	if err != nil || string(b) != "新对白" {
		t.Fatal(string(b), err)
	}
	old, err := s.GetProjectScriptRevision("local-user", p.ID, u.ID, 1)
	if err != nil || old.SourceText != "旧对白" {
		t.Fatal(old, err)
	}
	next := status.Path + "-移动"
	if err = os.Rename(status.Path, next); err != nil {
		t.Fatal(err)
	}
	edit.ExpectedRevision++
	edit.RequestID = "revision-2"
	edit.SourceText = "不得写入"
	if _, err = s.ReviseProjectScript("local-user", p.ID, u.ID, edit); err == nil {
		t.Fatal("offline edit accepted")
	}
	unit, err := s.GetProjectUnit("local-user", p.ID, u.ID)
	if err != nil || unit.SourceText != "新对白" {
		t.Fatal(unit, err)
	}
	n.selected = next
	rebound, err := s.RelocateProjectDirectory(context.Background(), "local-user", p.ID)
	if err != nil || rebound.Path != next || rebound.State != "ready" {
		t.Fatal(rebound, err)
	}
	if _, err = s.ReviseProjectScript("local-user", p.ID, u.ID, edit); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(status.Path); !os.IsNotExist(err) {
		t.Fatal("old path recreated")
	}
}
