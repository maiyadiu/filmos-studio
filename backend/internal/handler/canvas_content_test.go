package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/service"
)

func TestCanvasContentHTTPVersionContract(t *testing.T) {
	router := scriptHTTPFixture(t)
	call := func(method, path string, body any, auth bool) *httptest.ResponseRecorder {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
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
	decode := func(res *httptest.ResponseRecorder, want int) map[string]any {
		t.Helper()
		var envelope struct {
			Code int
			Data map[string]any
		}
		if json.Unmarshal(res.Body.Bytes(), &envelope) != nil || res.Code != want || (want == 200 && envelope.Code != 0) || (want != 200 && envelope.Code == 0) {
			t.Fatalf("response: %d %s", res.Code, res.Body.String())
		}
		return envelope.Data
	}
	path := "/api/canvas-projects/content-http"
	canvas := map[string]any{"id": "content-http", "nodes": []any{}, "title": "测试 <>& 正文"}
	put := func(hash string, auth bool) *httptest.ResponseRecorder {
		return call("PUT", path, map[string]any{"project": canvas, "expectedContentHash": hash}, auth)
	}
	decode(put("", false), 401)
	decode(put("not-a-hash", true), 400)
	decode(put(strings.Repeat("a", 64), true), 409)
	saved := decode(put("", true), 200)["project"].(map[string]any)
	hash, ok := saved["contentHash"].(string)
	if !ok || len(hash) != 64 {
		t.Fatal("missing save version")
	}
	read := decode(call("GET", path, nil, true), 200)
	if read["contentHash"] != hash || read["project"].(map[string]any)["title"] != canvas["title"] {
		t.Fatal("GET does not describe saved JSON")
	}
	snapshot := decode(call("GET", "/api/user-data/snapshot", nil, true), 200)
	if snapshot["projectContentHashes"].(map[string]any)["content-http"] != hash {
		t.Fatal("snapshot differs from exact GET/save")
	}
	canvas["title"] = "人工新版"
	updated := decode(put(hash, true), 200)["project"].(map[string]any)["contentHash"]
	if updated == hash {
		t.Fatal("changed content retained old hash")
	}
	canvas["title"] = "不应写入的旧基线"
	decode(put(hash, true), 409)
	decode(put("", true), 409)
	read = decode(call("GET", path, nil, true), 200)
	if read["contentHash"] != updated || read["project"].(map[string]any)["title"] != "人工新版" {
		t.Fatal("stale write changed current canvas")
	}
	decode(call("GET", path, nil, false), 401)
	decode(call("PUT", path, map[string]any{"project": map[string]any{"id": "wrong"}, "expectedContentHash": updated}, true), 400)
}
