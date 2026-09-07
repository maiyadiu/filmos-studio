package service

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func runtimeAccountFixture(t *testing.T) (*Service, *gorm.DB, RuntimeAccountChallenge) {
	t.Helper()
	dir := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(dir, "auth.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.User{}, &model.AuthSession{}); err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	t.Cleanup(func() { _ = conn.Close() })
	for _, id := range []string{"a", "b"} {
		for _, value := range []any{
			&model.User{ID: "user-" + id, Username: "user-" + id, Status: model.UserStatusActive, Role: model.UserRoleUser},
			&model.AuthSession{ID: "session-" + id, UserID: "user-" + id, TokenHash: hashToken("private-token-" + id), ExpiresAt: time.Now().Add(time.Hour)},
		} {
			if err := db.Create(value).Error; err != nil {
				t.Fatal(err)
			}
		}
	}
	return &Service{repo: repository.New(db), dataDir: dir}, db, RuntimeAccountChallenge{
		RuntimeInstanceID: strings.Repeat("i", 24), RuntimeSessionID: strings.Repeat("s", 24),
		KeyID: strings.Repeat("k", 43), Nonce: strings.Repeat("n", 32), Origin: "http://127.0.0.1:43100",
	}
}

func TestRuntimeAccountProofBindsRealAccountAndExactChallenge(t *testing.T) {
	svc, _, challenge := runtimeAccountFixture(t)
	for _, id := range []string{"a", "b"} {
		proof, err := svc.IssueRuntimeAccountProof("session-"+id+".private-token-"+id, challenge)
		if err != nil {
			t.Fatal(err)
		}
		identity, err := svc.VerifyRuntimeAccountProof(proof.Proof)
		if err != nil {
			t.Fatal(err)
		}
		if identity.UserID != "user-"+id || identity.AuthMode != AuthModeAccount || identity.Challenge != challenge || identity.ExpiresAt != proof.ExpiresAt || identity.ExpiresAt-identity.IssuedAt != 60 {
			t.Fatalf("wrong identity: %#v", identity)
		}
		body, _ := json.Marshal(identity)
		for _, secret := range []string{"private-token", "authSessionId", "role", "password", "keyPath"} {
			if strings.Contains(string(body), secret) {
				t.Fatalf("public identity includes %s", secret)
			}
		}
		parts := strings.Split(proof.Proof, ".")
		payload, _ := base64.RawURLEncoding.DecodeString(parts[0])
		if strings.Contains(string(payload), "private-token") {
			t.Fatal("proof contains login secret")
		}
		payload = []byte(strings.Replace(string(payload), "user-"+id, "forged-admin", 1))
		if _, err := svc.VerifyRuntimeAccountProof(base64.RawURLEncoding.EncodeToString(payload) + "." + parts[1]); err == nil {
			t.Fatal("forged identity accepted")
		}
	}
}

func TestRuntimeAccountProofRejectsNoAuthMalformedAndExpired(t *testing.T) {
	svc, _, challenge := runtimeAccountFixture(t)
	for _, cookie := range []string{"", "session-a.bad", "missing.private-token-a"} {
		if _, err := svc.IssueRuntimeAccountProof(cookie, challenge); err == nil {
			t.Fatal("unauthenticated issue accepted")
		}
		if err := svc.Logout(cookie); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Join(svc.dataDir, ".settings-key")); !os.IsNotExist(err) {
		t.Fatal("unauthenticated issue created key")
	}
	for _, proof := range []string{"", "bad", "a.b.c", "e30." + base64.RawURLEncoding.EncodeToString(make([]byte, 32)), strings.Repeat("a", 6145)} {
		if _, err := svc.VerifyRuntimeAccountProof(proof); err == nil {
			t.Fatal("invalid proof accepted")
		}
	}
	if _, err := os.Stat(filepath.Join(svc.dataDir, ".settings-key")); !os.IsNotExist(err) {
		t.Fatal("verification created key")
	}
	now := time.Now().Truncate(time.Second)
	proof, err := svc.issueRuntimeAccountProof("session-a.private-token-a", challenge, now)
	if err != nil {
		t.Fatal(err)
	}
	for _, at := range []time.Time{now.Add(time.Minute), now.Add(-6 * time.Second)} {
		if _, err := svc.verifyRuntimeAccountProof(proof.Proof, at); err == nil {
			t.Fatal("expired or future proof accepted")
		}
	}
	other, _, _ := runtimeAccountFixture(t)
	if _, err := other.IssueRuntimeAccountProof("session-a.private-token-a", challenge); err != nil {
		t.Fatal(err)
	}
	if _, err := other.VerifyRuntimeAccountProof(proof.Proof); err == nil {
		t.Fatal("other issuer proof accepted")
	}
}

func TestRuntimeAccountProofRejectsRevokedDisabledAndChangedSessions(t *testing.T) {
	for _, condition := range []string{"logout", "expired-session", "disabled", "rebound-session", "auth-mode-changed", "database-unavailable"} {
		t.Run(condition, func(t *testing.T) {
			svc, db, challenge := runtimeAccountFixture(t)
			proof, err := svc.IssueRuntimeAccountProof("session-a.private-token-a", challenge)
			if err != nil {
				t.Fatal(err)
			}
			switch condition {
			case "logout":
				err = svc.Logout("session-a.private-token-a")
			case "expired-session":
				err = db.Model(&model.AuthSession{}).Where("id = ?", "session-a").Update("expires_at", time.Now().Add(-time.Hour)).Error
			case "disabled":
				err = db.Model(&model.User{}).Where("id = ?", "user-a").Update("status", model.UserStatusDisabled).Error
			case "rebound-session":
				err = db.Model(&model.AuthSession{}).Where("id = ?", "session-a").Update("user_id", "user-b").Error
			case "auth-mode-changed":
				svc.runtimeCapabilities = RuntimeCapabilitiesForDeployment("127.0.0.1:43101", "false", "true")
			case "database-unavailable":
				conn, _ := db.DB()
				err = conn.Close()
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := svc.VerifyRuntimeAccountProof(proof.Proof); err == nil {
				t.Fatal("stale identity accepted")
			}
		})
	}
}

func TestRuntimeAccountChallengeRejectsUntrustedShapes(t *testing.T) {
	svc, _, original := runtimeAccountFixture(t)
	for _, origin := range []string{"http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?token=secret", "file:///tmp/foo", "https://example.com/", "https://example.com?"} {
		challenge := original
		challenge.Origin = origin
		if _, err := svc.IssueRuntimeAccountProof("session-a.private-token-a", challenge); err == nil {
			t.Fatalf("accepted origin %q", origin)
		}
	}
	for _, field := range []string{"instance", "session", "key", "nonce"} {
		challenge := original
		switch field {
		case "instance":
			challenge.RuntimeInstanceID = ""
		case "session":
			challenge.RuntimeSessionID = "bad"
		case "key":
			challenge.KeyID = "../escape"
		case "nonce":
			challenge.Nonce = strings.Repeat("a", 129)
		}
		if _, err := svc.IssueRuntimeAccountProof("session-a.private-token-a", challenge); err == nil {
			t.Fatalf("accepted invalid %s", field)
		}
	}
}
