package repository

import (
	"errors"
	"strings"
	"sync"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestCanvasContentCASAndCreateOnly(t *testing.T) {
	r, _ := promptRepository(t)
	base, _ := r.CanvasProjectForUser("owner", "c")
	hash := model.CanvasContentHash([]byte(base.PayloadJSON))
	next := *base
	next.PayloadJSON = strings.Replace(base.PayloadJSON, `"x":7`, `"x":17`, 1)
	if err := r.UpsertCanvasProject(&next, &hash); err != nil {
		t.Fatal(err)
	}
	stale := *base
	stale.PayloadJSON = strings.Replace(base.PayloadJSON, `"x":7`, `"x":27`, 1)
	empty := ""
	for _, expected := range []*string{&hash, &empty} {
		if err := r.UpsertCanvasProject(&stale, expected); !errors.Is(err, model.ErrCanvasContentConflict) {
			t.Fatalf("stale/create-only overwrite: %v", err)
		}
	}
	current, _ := r.CanvasProjectForUser("owner", "c")
	if current.PayloadJSON != next.PayloadJSON {
		t.Fatal("conflict changed saved canvas")
	}
	fresh := model.CanvasProject{ID: "new", UserID: "owner", PayloadJSON: `{"id":"new","nodes":[]}`}
	if err := r.UpsertCanvasProject(&fresh, &hash); !errors.Is(err, model.ErrCanvasContentConflict) {
		t.Fatalf("missing expected canvas: %v", err)
	}
	if err := r.UpsertCanvasProject(&fresh, &empty); err != nil {
		t.Fatal(err)
	}
	if err := r.UpsertCanvasProject(&fresh, &empty); !errors.Is(err, model.ErrCanvasContentConflict) {
		t.Fatalf("create-only replay must read back: %v", err)
	}
}

func TestCanvasContentCASConcurrentWriters(t *testing.T) {
	r, db := promptRepository(t)
	conn, _ := db.DB()
	// Serialize SQLite connection acquisition, not the separate caller checks:
	// both independent writers carry the same earlier observed version.
	conn.SetMaxOpenConns(1)
	base, _ := r.CanvasProjectForUser("owner", "c")
	hash := model.CanvasContentHash([]byte(base.PayloadJSON))
	start := make(chan struct{})
	results := make(chan error, 2)
	var done sync.WaitGroup
	for _, value := range []string{`"x":17`, `"x":27`} {
		done.Add(1)
		go func(value string) {
			defer done.Done()
			next := *base
			next.PayloadJSON = strings.Replace(base.PayloadJSON, `"x":7`, value, 1)
			<-start
			results <- New(db).UpsertCanvasProject(&next, &hash)
		}(value)
	}
	close(start)
	done.Wait()
	close(results)
	saved, conflicts := 0, 0
	for err := range results {
		if err == nil {
			saved++
		} else if errors.Is(err, model.ErrCanvasContentConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if saved != 1 || conflicts != 1 {
		t.Fatalf("saved=%d conflicts=%d", saved, conflicts)
	}
}
