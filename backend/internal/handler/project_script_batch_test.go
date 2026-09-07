package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"infinite-canvas/backend/internal/service"
)

func TestScriptBatchHTTPAuthConflictAndReadback(t *testing.T) {
	router := scriptHTTPFixture(t)
	call := func(method, path string, body any, authorized bool) *httptest.ResponseRecorder {
		encoded, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(encoded))
		req.Header.Set("Content-Type", "application/json")
		if authorized {
			req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "script-session.script-test-token"})
		}
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res
	}
	input := service.CreateProjectScriptBatchRequest{ExpectedProjectRevision: 1, RequestID: "http-batch", Note: "HTTP fixture", Chapters: []service.ScriptChapterInput{{Title: "新章", SourceText: "<p>新对白</p>"}}}
	if r := call("POST", "/api/projects/project/script-batches", input, false); r.Code != 401 {
		t.Fatal(r.Code)
	}
	if r := call("POST", "/api/projects/foreign/script-batches", input, true); r.Code != 404 {
		t.Fatal(r.Code)
	}
	created := call("POST", "/api/projects/project/script-batches", input, true)
	if created.Code != 200 {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	var envelope struct {
		Code int                              `json:"code"`
		Data service.ProjectScriptBatchResult `json:"data"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &envelope); err != nil || envelope.Code != 0 || len(envelope.Data.Revisions) != 1 {
		t.Fatal("bad creation envelope")
	}
	id := envelope.Data.Receipt.ID
	read := call("GET", "/api/projects/project/script-batches/http-batch", nil, true)
	if read.Code != 200 {
		t.Fatal(read.Code)
	}
	if err := json.Unmarshal(read.Body.Bytes(), &envelope); err != nil || envelope.Data.Receipt.ID != id || envelope.Data.Revisions[0].SourceText != input.Chapters[0].SourceText {
		t.Fatal("readback mismatch")
	}
	retry := call("POST", "/api/projects/project/script-batches", input, true)
	if err := json.Unmarshal(retry.Body.Bytes(), &envelope); err != nil || !envelope.Data.Replayed || envelope.Data.Receipt.ID != id {
		t.Fatal("replay mismatch")
	}
	input.RequestID = "stale"
	if r := call("POST", "/api/projects/project/script-batches", input, true); r.Code != 409 {
		t.Fatal(r.Code)
	}
	if r := call("GET", "/api/projects/project/script-batches/missing", nil, true); r.Code != 404 {
		t.Fatal(r.Code)
	}
	if r := call("GET", "/api/projects/foreign/script-batches/http-batch", nil, true); r.Code != 404 {
		t.Fatal(r.Code)
	}
}
