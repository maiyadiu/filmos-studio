package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/service"
)

func TestCanvasPromptHTTPAuthSaveHistoryAndConflict(t *testing.T) {
	router := scriptHTTPFixture(t)
	call := func(method, path string, body any, auth bool) *httptest.ResponseRecorder {
		var raw []byte
		if body != nil {
			var err error
			raw, err = json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
		}
		req := httptest.NewRequest(method, path, strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
		if auth {
			req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "script-session.script-test-token"})
		}
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res
	}
	shotPath := "/api/projects/project/units/unit/shots"
	res := call("GET", shotPath, nil, true)
	var shotContext struct{ Data service.ProjectShotContext }
	if err := json.Unmarshal(res.Body.Bytes(), &shotContext); err != nil || res.Code != 200 {
		t.Fatal("shot context unavailable")
	}
	var shotWrite map[string]any
	_ = json.Unmarshal([]byte(`{"requestId":"prompt-http-shot","expectedShotRevision":0,"sourceRevision":1,"sourceParagraphIds":["p0002"],"shots":[{"title":"回应","description":"林夏留在客厅","position":0,"durationMs":5000,"expectedRevision":0,"content":{"scene":"客厅","characters":["林夏"],"action":"留在原处","camera":"中景","sourceReferences":[{"paragraphId":"p0002","quote":"林夏：我不走。"}],"dialogue":[{"speaker":"林夏","text":"我不走。","paragraphId":"p0002"}]}}]}`), &shotWrite)
	shotWrite["sourceHash"] = shotContext.Data.SourceHash
	if res := call("PUT", shotPath, shotWrite, true); res.Code != 200 {
		t.Fatalf("shot save: %s", res.Body.String())
	}
	res = call("GET", shotPath, nil, true)
	_ = json.Unmarshal(res.Body.Bytes(), &shotContext)
	shot := shotContext.Data.Shots[0]
	rowID := "project-shot:" + shot.ID
	canvas := map[string]any{"id": "prompt-http", "projectId": "project", "nodes": []any{map[string]any{"id": "node", "type": "script", "metadata": map[string]any{"chapterId": "unit", "storyboard": map[string]any{"rows": []any{map[string]any{"id": rowID, "projectShotSource": map[string]any{"id": shot.ID, "revision": shot.Revision, "sourceRevision": shot.SourceRevision, "sourceHash": shot.SourceHash}, "imageGenerationPrompt": "原版正文", "videoMotionPrompt": "未改视频"}}}}}}}
	canvasPath := "/api/canvas-projects/prompt-http"
	if res := call("PUT", canvasPath, map[string]any{"project": canvas}, true); res.Code != 200 {
		t.Fatalf("canvas save: %s", res.Body.String())
	}
	if res := call("POST", "/api/projects/project/canvas-links", map[string]string{"canvasId": "prompt-http", "unitId": "unit", "role": "storyboard"}, true); res.Code != 200 {
		t.Fatalf("canvas link: %s", res.Body.String())
	}
	path := canvasPath + "/prompt-drafts"
	query := "?" + url.Values{"projectId": {"project"}, "nodeId": {"node"}, "rowId": {rowID}, "kind": {"image"}}.Encode()
	for _, endpoint := range []string{path + query, path + "/history" + query, path + "/history/0" + query, path + "/requests/one"} {
		if res := call("GET", endpoint, nil, false); res.Code != 401 {
			t.Fatalf("unauthenticated read: %d", res.Code)
		}
	}
	res = call("GET", path+query, nil, true)
	var context struct {
		Code int
		Data service.CanvasPromptContext
	}
	if err := json.Unmarshal(res.Body.Bytes(), &context); err != nil || res.Code != 200 || context.Code != 0 || context.Data.Managed {
		t.Fatalf("prompt context: %s", res.Body.String())
	}
	req := service.SaveCanvasPromptRequest{CanvasPromptTargetRequest: service.CanvasPromptTargetRequest{ProjectID: "project", NodeID: "node", RowID: rowID, Kind: "image"}, RequestID: "one", ExpectedRevision: &context.Data.State.Revision, ExpectedContentHash: context.Data.State.ContentHash, DependencyHash: context.Data.DependencyHash, Prompt: "  第一行\n\n第二行，保留。\n"}
	if res := call("POST", path, req, false); res.Code != 401 {
		t.Fatal("unauthenticated write")
	}
	var saved struct {
		Code int
		Data service.CanvasPromptSaveResult
	}
	for i := 0; i < 2; i++ {
		res = call("POST", path, req, true)
		if err := json.Unmarshal(res.Body.Bytes(), &saved); err != nil || res.Code != 200 || saved.Code != 0 || saved.Data.Replayed != (i == 1) {
			t.Fatalf("save/retry: %s", res.Body.String())
		}
	}
	for _, endpoint := range []string{path + "/history/1" + query, path + "/requests/one"} {
		res = call("GET", endpoint, nil, true)
		var data map[string]any
		_ = json.Unmarshal(res.Body.Bytes(), &data)
		if res.Code != 200 || data["code"] != float64(0) || !strings.Contains(res.Body.String(), saved.Data.Receipt.Snapshot.ContentHash) {
			t.Fatalf("exact read: %s", res.Body.String())
		}
	}

	res = call("GET", path+query, nil, true)
	if err := json.Unmarshal(res.Body.Bytes(), &context); err != nil || res.Code != 200 || context.Data.CanvasUpdatedAt != saved.Data.Receipt.Snapshot.CreatedAt.Format(time.RFC3339Nano) {
		t.Fatal("prompt context must carry the canvas timestamp written with the saved prompt")
	}
	res = call("GET", path+"/history"+query, nil, true)
	if res.Code != 200 || strings.Contains(res.Body.String(), `"prompt"`) || strings.Contains(res.Body.String(), `"dependencies"`) {
		t.Fatal("history index leaks large body instead of metadata")
	}
	res = call("GET", path+"/history/0"+query, nil, true)
	if res.Code != 200 || !strings.Contains(res.Body.String(), "原版正文") {
		t.Fatal("baseline lost")
	}
	changed := req
	changed.Prompt = "同请求不同内容"
	for _, response := range []*httptest.ResponseRecorder{call("POST", path, changed, true), call("PUT", canvasPath, map[string]any{"project": canvas}, true)} {
		var envelope struct{ Code int }
		_ = json.Unmarshal(response.Body.Bytes(), &envelope)
		if response.Code != 409 || envelope.Code == 0 {
			t.Fatalf("false success on conflict: %d %s", response.Code, response.Body.String())
		}
	}
	res = call("GET", canvasPath, nil, true)
	if res.Code != 200 || !strings.Contains(res.Body.String(), saved.Data.Receipt.Snapshot.ContentHash) || !strings.Contains(res.Body.String(), "未改视频") {
		t.Fatal("saved canvas and receipt differ")
	}
	if res := call("GET", path+"/history/not-a-number"+query, nil, true); res.Code != 400 {
		t.Fatal("invalid revision accepted")
	}
	if res := call("GET", strings.Replace(path, "prompt-http", "missing", 1)+"/requests/one", nil, true); res.Code != 404 {
		t.Fatal("receipt exposed across canvas")
	}
}
