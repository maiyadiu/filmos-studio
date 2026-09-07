package service

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

const runtimeAccountProtocol = "filmos-runtime-account-v1"
const runtimeAccountProofTTL = time.Minute

var runtimeAccountID = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// Identity proof only: it grants no project, tool, engineering or model authority.
type RuntimeAccountChallenge struct {
	RuntimeInstanceID string `json:"runtimeInstanceId"`
	RuntimeSessionID  string `json:"runtimeSessionId"`
	KeyID             string `json:"keyId"`
	Nonce             string `json:"nonce"`
	Origin            string `json:"origin"`
}

type RuntimeAccountIdentity struct {
	Protocol  string                  `json:"protocol"`
	UserID    string                  `json:"userId"`
	AuthMode  string                  `json:"authMode"`
	Challenge RuntimeAccountChallenge `json:"challenge"`
	IssuedAt  int64                   `json:"issuedAt"`
	ExpiresAt int64                   `json:"expiresAt"`
}

type RuntimeAccountProof struct {
	Proof     string `json:"proof"`
	ExpiresAt int64  `json:"expiresAt"`
}

type runtimeAccountClaims struct {
	RuntimeAccountIdentity
	AuthSessionID string `json:"authSessionId,omitempty"`
}

func (s *Service) IssueRuntimeAccountProof(cookie string, challenge RuntimeAccountChallenge) (*RuntimeAccountProof, error) {
	return s.issueRuntimeAccountProof(cookie, challenge, time.Now())
}

func (s *Service) issueRuntimeAccountProof(cookie string, challenge RuntimeAccountChallenge, now time.Time) (*RuntimeAccountProof, error) {
	user, err := s.CurrentUser(cookie)
	if err != nil {
		return nil, err
	}
	if !validRuntimeAccountChallenge(challenge) {
		return nil, BadAuthRequest("本机账号证明参数无效")
	}
	claims := runtimeAccountClaims{RuntimeAccountIdentity: RuntimeAccountIdentity{
		Protocol: runtimeAccountProtocol, UserID: user.ID, AuthMode: s.AuthMode(), Challenge: challenge,
		IssuedAt: now.Unix(), ExpiresAt: now.Add(runtimeAccountProofTTL).Unix(),
	}}
	if !s.DesktopLocalAuthEnabled() {
		claims.AuthSessionID, _ = parseSessionCookie(cookie)
	}
	if err := s.validateRuntimeAccountUser(claims, now); err != nil {
		return nil, err
	}
	body, err := json.Marshal(claims)
	if err != nil {
		return nil, err
	}
	mac, err := s.runtimeAccountMAC(body, true)
	if err != nil {
		return nil, err
	}
	return &RuntimeAccountProof{Proof: base64.RawURLEncoding.EncodeToString(body) + "." + base64.RawURLEncoding.EncodeToString(mac), ExpiresAt: claims.ExpiresAt}, nil
}

func (s *Service) VerifyRuntimeAccountProof(proof string) (*RuntimeAccountIdentity, error) {
	return s.verifyRuntimeAccountProof(proof, time.Now())
}

func (s *Service) verifyRuntimeAccountProof(proof string, now time.Time) (*RuntimeAccountIdentity, error) {
	invalid := func() (*RuntimeAccountIdentity, error) {
		return nil, Unauthorized("本机账号证明无效或已过期")
	}
	if len(proof) > 6144 {
		return invalid()
	}
	parts := strings.Split(proof, ".")
	if len(parts) != 2 {
		return invalid()
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(body) > 4096 || base64.RawURLEncoding.EncodeToString(body) != parts[0] {
		return invalid()
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(signature) != sha256.Size || base64.RawURLEncoding.EncodeToString(signature) != parts[1] {
		return invalid()
	}
	expected, err := s.runtimeAccountMAC(body, false)
	if err != nil {
		return nil, err
	}
	if !hmac.Equal(signature, expected) {
		return invalid()
	}
	var claims runtimeAccountClaims
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claims); err != nil {
		return invalid()
	}
	if claims.Protocol != runtimeAccountProtocol || !validRuntimeAccountChallenge(claims.Challenge) || claims.UserID == "" ||
		claims.IssuedAt > now.Unix()+5 || claims.ExpiresAt <= now.Unix() || claims.ExpiresAt <= claims.IssuedAt ||
		claims.ExpiresAt-claims.IssuedAt > int64(runtimeAccountProofTTL/time.Second) || claims.AuthMode != s.AuthMode() {
		return invalid()
	}
	if err := s.validateRuntimeAccountUser(claims, now); err != nil {
		return nil, err
	}
	return &claims.RuntimeAccountIdentity, nil
}

func (s *Service) validateRuntimeAccountUser(claims runtimeAccountClaims, now time.Time) error {
	if claims.AuthMode == AuthModeDesktopLocal {
		if !s.DesktopLocalAuthEnabled() || claims.UserID != desktopLocalUserID || claims.AuthSessionID != "" {
			return Unauthorized("本机账号证明身份不符")
		}
	} else {
		if claims.AuthMode != AuthModeAccount || claims.AuthSessionID == "" {
			return Unauthorized("本机账号证明身份不符")
		}
		session, err := s.repo.AuthSession(claims.AuthSessionID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return Unauthorized("登录状态已失效")
		}
		if err != nil {
			return err
		}
		if session.UserID != claims.UserID || !now.Before(session.ExpiresAt) {
			return Unauthorized("登录状态已失效")
		}
	}
	user, err := s.repo.User(claims.UserID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Unauthorized("登录状态已失效")
	}
	if err != nil {
		return err
	}
	if user.Status != model.UserStatusActive {
		return Forbidden("该账号已被禁用")
	}
	return nil
}

func validRuntimeAccountChallenge(c RuntimeAccountChallenge) bool {
	for _, value := range []string{c.RuntimeInstanceID, c.RuntimeSessionID, c.KeyID, c.Nonce} {
		if !runtimeAccountID.MatchString(value) {
			return false
		}
	}
	if len(c.Origin) > 2048 {
		return false
	}
	u, err := url.Parse(c.Origin)
	if err != nil || u.User != nil || u.Host == "" || u.Path != "" || u.ForceQuery || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" || u.String() != c.Origin {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	return u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")
}

func (s *Service) runtimeAccountMAC(body []byte, create bool) ([]byte, error) {
	var key []byte
	var err error
	if create {
		key, err = s.settingsEncryptionKey()
	} else {
		// Verification must not create/replace a secret on an unauthenticated request.
		key, err = os.ReadFile(filepath.Join(s.dataDir, ".settings-key"))
		if errors.Is(err, os.ErrNotExist) {
			return nil, Unauthorized("本机账号证明无效或已过期")
		}
	}
	if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, errors.New("runtime account signing key invalid")
	}
	derive := hmac.New(sha256.New, key)
	derive.Write([]byte(runtimeAccountProtocol + ":signing-key"))
	mac := hmac.New(sha256.New, derive.Sum(nil))
	mac.Write(body)
	return mac.Sum(nil), nil
}
