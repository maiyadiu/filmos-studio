package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/service"
)

func TestChapterCanvasHTTPIdentityAndReplay(t *testing.T) {
	router := scriptHTTPFixture(t)
	var first string
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/projects/project/units/unit/chapter-canvas", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "script-session.script-test-token"})
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		var body struct {
			Code int `json:"code"`
			Data struct {
				Canvas      model.CanvasProject `json:"canvas"`
				Disposition string              `json:"disposition"`
			} `json:"data"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil || res.Code != 200 || body.Code != 0 {
			t.Fatalf("response %d %s %v", res.Code, res.Body.String(), err)
		}
		if body.Data.Canvas.ProjectID != "project" || body.Data.Canvas.UserID != "owner" || body.Data.Canvas.ID == "" {
			t.Fatal("wrong identity")
		}
		if i == 0 {
			first = body.Data.Canvas.ID
			if body.Data.Disposition != "created" {
				t.Fatal(body)
			}
		} else if first != body.Data.Canvas.ID || body.Data.Disposition != "reused" {
			t.Fatal("duplicate response", body)
		}
	}
	for _, target := range []struct {
		path   string
		auth   bool
		status int
	}{
		{"/api/projects/project/units/unit/chapter-canvas", false, 401},
		{"/api/projects/foreign/units/unit/chapter-canvas", true, 404},
		{"/api/projects/project/units/other-unit/chapter-canvas", true, 404},
	} {
		req := httptest.NewRequest(http.MethodPost, target.path, strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		if target.auth {
			req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "script-session.script-test-token"})
		}
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != target.status {
			t.Fatalf("scope %d %s", res.Code, res.Body.String())
		}
	}
}
