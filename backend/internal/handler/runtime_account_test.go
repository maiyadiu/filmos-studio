package handler

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/service"
)

func runtimeAccountPost(router *gin.Engine, path, cookie, origin, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: cookie})
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	return w
}

func runtimeAccountHTTPChallenge() service.RuntimeAccountChallenge {
	return service.RuntimeAccountChallenge{RuntimeInstanceID: strings.Repeat("i", 24), RuntimeSessionID: strings.Repeat("s", 24), KeyID: strings.Repeat("k", 43), Nonce: strings.Repeat("n", 32), Origin: "http://127.0.0.1:43100"}
}

func TestRuntimeAccountHTTPProofUsesLoginNotCallerIdentity(t *testing.T) {
	router, db := authSessionFixture(t, "127.0.0.1:43101", "false")
	challenge := runtimeAccountHTTPChallenge()
	payload, _ := json.Marshal(challenge)
	post := func(cookie, body string) *httptest.ResponseRecorder {
		return runtimeAccountPost(router, "/api/auth/runtime-account/proof", cookie, challenge.Origin, body)
	}
	if w := post("", string(payload)); w.Code != 401 {
		t.Fatalf("anonymous status=%d", w.Code)
	}
	for _, id := range []string{"a", "b"} {
		token := "private-token-" + id
		hash := sha256.Sum256([]byte(token))
		for _, value := range []any{&model.User{ID: "user-" + id, Username: "user-" + id, Status: model.UserStatusActive}, &model.AuthSession{ID: "session-" + id, UserID: "user-" + id, TokenHash: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)}} {
			if err := db.Create(value).Error; err != nil {
				t.Fatal(err)
			}
		}
		if w := post("session-"+id+".wrong", string(payload)); w.Code != 401 {
			t.Fatal("wrong secret accepted")
		}
		runtimeAccountPost(router, "/api/auth/logout", "session-"+id+".wrong", challenge.Origin, `{}`)
		w := post("session-"+id+"."+token, string(payload))
		var result struct {
			Code int
			Data service.RuntimeAccountProof
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || result.Code != 0 || result.Data.Proof == "" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("issue status=%d", w.Code)
		}
		proofBody, _ := json.Marshal(map[string]string{"proof": result.Data.Proof})
		verified := runtimeAccountPost(router, "/api/auth/runtime-account/verify", "", "", string(proofBody))
		var identity struct {
			Code int
			Data service.RuntimeAccountIdentity
		}
		if err := json.Unmarshal(verified.Body.Bytes(), &identity); err != nil {
			t.Fatal(err)
		}
		if verified.Code != 200 || identity.Code != 0 || identity.Data.UserID != "user-"+id || identity.Data.Challenge != challenge {
			t.Fatalf("verify status=%d", verified.Code)
		}
		for _, secret := range []string{token, "authSessionId", "role", "PasswordHash"} {
			if strings.Contains(verified.Body.String(), secret) {
				t.Fatal("private identity data returned")
			}
		}
		if err := db.Delete(&model.AuthSession{}, "id = ?", "session-"+id).Error; err != nil {
			t.Fatal(err)
		}
		if w := runtimeAccountPost(router, "/api/auth/runtime-account/verify", "", "", string(proofBody)); w.Code != 401 {
			t.Fatal("logged-out proof accepted")
		}
	}
	for _, body := range []string{`null`, `{"userId":"admin"}`, string(payload) + `{}`, strings.Repeat("x", 8193), strings.TrimSuffix(string(payload), "}") + `,"userId":"admin"}`} {
		if w := post("", body); w.Code == 200 {
			t.Fatal("invalid shape accepted")
		}
	}
	if w := runtimeAccountPost(router, "/api/auth/runtime-account/proof", "", "https://different.invalid", string(payload)); w.Code != 403 {
		t.Fatal("wrong origin accepted")
	}
	if w := authSessionGet(router, "/api/auth/runtime-account/verify", ""); w.Code == 200 {
		t.Fatal("proof accepted through GET")
	}
}

func TestRuntimeAccountHTTPDesktopScopeAndDatabaseFailure(t *testing.T) {
	for _, setup := range []struct {
		bind, flag string
		want       int
	}{{"127.0.0.1:43101", "true", 200}, {"0.0.0.0:43101", "true", 401}} {
		t.Run(setup.bind, func(t *testing.T) {
			router, db := authSessionFixture(t, setup.bind, setup.flag)
			challenge := runtimeAccountHTTPChallenge()
			body, _ := json.Marshal(challenge)
			w := runtimeAccountPost(router, "/api/auth/runtime-account/proof", "", challenge.Origin, string(body))
			if w.Code != setup.want {
				t.Fatalf("status=%d", w.Code)
			}
			if setup.want != 200 {
				return
			}
			var proof struct{ Data service.RuntimeAccountProof }
			_ = json.Unmarshal(w.Body.Bytes(), &proof)
			payload, _ := json.Marshal(map[string]string{"proof": proof.Data.Proof})
			verified := runtimeAccountPost(router, "/api/auth/runtime-account/verify", "", "", string(payload))
			if verified.Code != 200 || !strings.Contains(verified.Body.String(), `"authMode":"desktop_local"`) {
				t.Fatal("desktop proof not verified")
			}
			conn, _ := db.DB()
			_ = conn.Close()
			failed := runtimeAccountPost(router, "/api/auth/runtime-account/verify", "", "", string(payload))
			if failed.Code != 500 || strings.Contains(failed.Body.String(), "database") || strings.Contains(failed.Body.String(), proof.Data.Proof) {
				t.Fatalf("unsafe failure status=%d", failed.Code)
			}
		})
	}
}
