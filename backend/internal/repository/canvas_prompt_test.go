package repository

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/model"
)

const promptRepositoryCanvas = `{"id":"c","projectId":"p","nodes":[{"id":"n","type":"script","position":{"x":7},"metadata":{"chapterId":"u1","storyboard":{"rows":[{"id":"r","projectShotSource":{"id":"s"},"imageGenerationPrompt":"旧稿","videoMotionPrompt":"视频不变"}]}}}]}`

func promptRepository(t *testing.T) (*Repository, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "prompt.db")+"?_busy_timeout=5000&_journal_mode=WAL"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	t.Cleanup(func() { _ = conn.Close() })
	if err := db.AutoMigrate(&model.CanvasProject{}, &model.CanvasPromptRevision{}, &model.CanvasPromptReceipt{}); err != nil {
		t.Fatal(err)
	}
	r := New(db)
	if err := r.UpsertCanvasProject(&model.CanvasProject{ID: "c", UserID: "owner", ProjectID: "p", PayloadJSON: promptRepositoryCanvas}); err != nil {
		t.Fatal(err)
	}
	return r, db
}

func promptRepositoryWrite(t *testing.T, r *Repository, requestID string, expected int64, fail bool) error {
	t.Helper()
	return r.ChangeCanvasPrompt("owner", "c", func(tx *Repository, current model.CanvasProject) (string, error) {
		doc, err := model.ParseCanvasPromptDocument([]byte(current.PayloadJSON))
		if err != nil {
			return "", err
		}
		target, err := doc.Target("n", "r")
		if err != nil {
			return "", err
		}
		state, _, err := target.State("image")
		if err != nil {
			return "", err
		}
		if state.Revision != expected {
			return "", model.ErrCanvasPromptConflict
		}
		now := time.Now().UTC()
		text := "保存 " + requestID
		revision := model.CanvasPromptRevision{ID: requestID, UserID: "owner", CanvasID: "c", NodeID: "n", RowID: "r", Kind: "image", Revision: expected + 1, Prompt: text, ContentHash: ScriptSourceHash(text), DependencyHash: strings.Repeat("b", 64), Dependencies: json.RawMessage(`{"shotId":"s","large":9007199254740993}`), RequestID: requestID, CreatedAt: now}
		if err := tx.AppendCanvasPromptRevision(revision, false); err != nil {
			return "", err
		}
		if err := tx.AppendCanvasPromptReceipt(model.CanvasPromptReceipt{ID: requestID, UserID: "owner", CanvasID: "c", RequestID: requestID, RequestHash: ScriptSourceHash(requestID), Snapshot: revision, CreatedAt: now}); err != nil {
			return "", err
		}
		if fail {
			return "", errors.New("injected final write failure")
		}
		raw, err := target.SetPrompt("image", text, model.CanvasPromptState{Revision: revision.Revision, ContentHash: revision.ContentHash, DependencyHash: revision.DependencyHash})
		return string(raw), err
	})
}

func TestCanvasPromptRepositoryAtomicHistoryAndReceipt(t *testing.T) {
	r, db := promptRepository(t)
	if err := promptRepositoryWrite(t, r, "one", 0, false); err != nil {
		t.Fatal(err)
	}
	first, _ := r.CanvasProjectForUser("owner", "c")
	rows, err := r.CanvasPromptRevisions("owner", "c", "n", "r", "image")
	if err != nil || len(rows) != 1 {
		t.Fatalf("history: %v %v", rows, err)
	}
	receipt, err := r.CanvasPromptReceipt("owner", "c", "one")
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(rows[0])
	b, _ := json.Marshal(receipt.Snapshot)
	if string(a) != string(b) || !strings.Contains(string(a), "9007199254740993") || rows[0].UserID != "owner" {
		t.Fatal("database history/receipt serialization changed persisted values")
	}
	if err := promptRepositoryWrite(t, r, "rollback", 1, true); err == nil {
		t.Fatal("expected injected failure")
	}
	current, _ := r.CanvasProjectForUser("owner", "c")
	if current.PayloadJSON != first.PayloadJSON {
		t.Fatal("failed transaction changed current prompt")
	}
	for _, row := range []any{&model.CanvasPromptRevision{}, &model.CanvasPromptReceipt{}} {
		var count int64
		if err := db.Model(row).Count(&count).Error; err != nil || count != 1 {
			t.Fatalf("rollback leaked history/receipt: %d %v", count, err)
		}
	}
	if _, err := r.CanvasPromptReceipt("foreign", "c", "one"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatal("foreign receipt exposed")
	}
	if rows, err := r.CanvasPromptRevisions("foreign", "c", "n", "r", "image"); err != nil || len(rows) != 0 {
		t.Fatal("foreign history exposed")
	}
	called := false
	if err := r.ChangeCanvasPrompt("foreign", "c", func(_ *Repository, _ model.CanvasProject) (string, error) { called = true; return "", nil }); !errors.Is(err, gorm.ErrRecordNotFound) || called {
		t.Fatal("foreign canvas callback invoked")
	}
}

func TestCanvasPromptRepositoryWholeCanvasAndBulkGuard(t *testing.T) {
	r, _ := promptRepository(t)
	if err := promptRepositoryWrite(t, r, "one", 0, false); err != nil {
		t.Fatal(err)
	}
	current, _ := r.CanvasProjectForUser("owner", "c")
	stale := *current
	stale.PayloadJSON = promptRepositoryCanvas
	if err := r.UpsertCanvasProject(&stale); !errors.Is(err, model.ErrCanvasPromptConflict) {
		t.Fatalf("stale PUT: %v", err)
	}
	for _, input := range [][]model.CanvasProject{nil, {stale}, {*current, *current}} {
		if err := r.ReplaceCanvasProjects("owner", input); !errors.Is(err, model.ErrCanvasPromptConflict) {
			t.Fatalf("bulk overwrite/delete/duplicate: %v", err)
		}
		saved, _ := r.CanvasProjectForUser("owner", "c")
		if saved.PayloadJSON != current.PayloadJSON {
			t.Fatal("rejected bulk replacement mutated source")
		}
	}
	layout := *current
	layout.PayloadJSON = strings.Replace(current.PayloadJSON, `"x":7`, `"x":8`, 1)
	if err := r.UpsertCanvasProject(&layout); err != nil {
		t.Fatalf("layout: %v", err)
	}
	if err := r.ReplaceCanvasProjects("owner", []model.CanvasProject{layout}); err != nil {
		t.Fatalf("exact bulk replay: %v", err)
	}
	forged := layout
	forged.ID = "forged"
	if err := r.UpsertCanvasProject(&forged); !errors.Is(err, model.ErrCanvasPromptConflict) {
		t.Fatalf("forged creation: %v", err)
	}
	foreign := model.CanvasProject{ID: "foreign", UserID: "foreign", PayloadJSON: `{"nodes":[]}`}
	if err := r.ReplaceCanvasProjects("owner", []model.CanvasProject{foreign}); !errors.Is(err, model.ErrCanvasPromptConflict) {
		t.Fatal("bulk writer accepted foreign ownership")
	}
	rows, _ := r.CanvasPromptRevisions("owner", "c", "n", "r", "image")
	if len(rows) != 1 {
		t.Fatal("bulk replay lost or duplicated history")
	}
}

func TestCanvasPromptRepositoryConcurrentWritersHaveOneWinner(t *testing.T) {
	r, db := promptRepository(t)
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, id := range []string{"a", "b"} {
		wg.Add(1)
		go func(id string) { defer wg.Done(); <-start; results <- promptRepositoryWrite(t, New(db), id, 0, false) }(id)
	}
	close(start)
	wg.Wait()
	close(results)
	winners := 0
	for err := range results {
		if err == nil {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("winners=%d", winners)
	}
	rows, _ := r.CanvasPromptRevisions("owner", "c", "n", "r", "image")
	if len(rows) != 1 {
		t.Fatalf("history count=%d", len(rows))
	}
	current, _ := r.CanvasProjectForUser("owner", "c")
	doc, _ := model.ParseCanvasPromptDocument([]byte(current.PayloadJSON))
	target, _ := doc.Target("n", "r")
	if model.CanvasJSONText(target.Row, "imageGenerationPrompt") != rows[0].Prompt {
		t.Fatal("current and winning receipt differ")
	}
}
