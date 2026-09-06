package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/service"
)

func TestProjectShotHTTPAtomicAuthAndReadback(t *testing.T) {
	router := scriptHTTPFixture(t)
	call := func(method, path, body string, auth bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if auth {
			req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "script-session.script-test-token"})
		}
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res
	}
	path := "/api/projects/project/units/unit/shots"
	for _, row := range []struct {
		path   string
		auth   bool
		status int
	}{
		{path, false, 401}, {"/api/projects/foreign/units/unit/shots", true, 404}, {"/api/projects/project/units/other-unit/shots", true, 404},
	} {
		if res := call("GET", row.path, "", row.auth); res.Code != row.status {
			t.Fatalf("read scope: %d %s", res.Code, res.Body.String())
		}
	}
	res := call("GET", path, "", true)
	var context struct{ Data service.ProjectShotContext }
	if err := json.Unmarshal(res.Body.Bytes(), &context); err != nil || res.Code != 200 || context.Data.Unit.ShotRevision != 0 || len(context.Data.Paragraphs) != 3 {
		t.Fatalf("read context: %s %v", res.Body.String(), err)
	}
	body := `{"requestId":"http-once","expectedShotRevision":0,"sourceRevision":1,"sourceParagraphIds":["p0002"],"sourceHash":"` + context.Data.SourceHash + `","shots":[{"title":"回应","description":"林夏留在客厅","position":0,"durationMs":5000,"expectedRevision":0,"content":{"scene":"客厅","characters":["林夏"],"action":"留在原处","camera":"中景","sourceReferences":[{"paragraphId":"p0002","quote":"林夏：我不走。"}],"dialogue":[{"speaker":"林夏","text":"我不走。","paragraphId":"p0002"}]}}]}`
	if res := call("PUT", path, body, false); res.Code != 401 {
		t.Fatal("unauthenticated write")
	}
	var saved repository.ShotBatchResult
	for i := 0; i < 2; i++ {
		res := call("PUT", path, body, true)
		var envelope struct {
			Code int
			Data repository.ShotBatchResult
		}
		if err := json.Unmarshal(res.Body.Bytes(), &envelope); err != nil || res.Code != 200 || envelope.Code != 0 || envelope.Data.Replayed != (i == 1) || len(envelope.Data.Receipt.Shots) != 1 {
			t.Fatalf("batch/retry: %s %v", res.Body.String(), err)
		}
		saved = envelope.Data
	}
	for _, endpoint := range []string{
		"/api/projects/project/units/unit/shot-batches/http-once",
		"/api/projects/project/shots/" + saved.Receipt.Shots[0].ID + "/revisions",
	} {
		res := call("GET", endpoint, "", true)
		if res.Code != 200 || !strings.Contains(res.Body.String(), saved.Receipt.Shots[0].ID) || !strings.Contains(res.Body.String(), "我不走。") {
			t.Fatalf("persisted read: %s", res.Body.String())
		}
		if res := call("GET", strings.Replace(endpoint, "/project/", "/foreign/", 1), "", true); res.Code != 404 {
			t.Fatal("foreign receipt/history visible")
		}
	}
	for _, invalid := range []struct {
		body   string
		status int
	}{
		{`{"shots":[{"title":"旧的破坏性全章替换"}]}`, 400},
		{strings.Replace(body, "http-once", "stale-new-request", 1), 409},
		{strings.Replace(body, "回应", "changed", 1), 409},
	} {
		res := call("PUT", path, invalid.body, true)
		var envelope struct{ Code int }
		_ = json.Unmarshal(res.Body.Bytes(), &envelope)
		if res.Code != invalid.status || envelope.Code == 0 {
			t.Fatalf("false success: %d %s", res.Code, res.Body.String())
		}
	}
	res = call("GET", path, "", true)
	_ = json.Unmarshal(res.Body.Bytes(), &context)
	if context.Data.Unit.ShotRevision != 1 || len(context.Data.Shots) != 1 || context.Data.Shots[0].Revision != 1 || context.Data.Shots[0].ID != saved.Receipt.Shots[0].ID {
		t.Fatal("duplicate or stale overwrite")
	}
	detailResponse := call("GET", "/api/projects/project", "", true)
	var detail struct {
		Data struct{ Units []model.ProjectUnit }
	}
	if err := json.Unmarshal(detailResponse.Body.Bytes(), &detail); err != nil || detailResponse.Code != 200 {
		t.Fatalf("project summary: %s %v", detailResponse.Body.String(), err)
	}
	found := false
	for _, unit := range detail.Data.Units {
		if unit.ID == "unit" {
			found = true
			if unit.ShotRevision != context.Data.Unit.ShotRevision || unit.SourceText != "" {
				t.Fatal("summary lost shot revision or exposed full source")
			}
		}
	}
	if !found {
		t.Fatal("unit summary missing")
	}
}
