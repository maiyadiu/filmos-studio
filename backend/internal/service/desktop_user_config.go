package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const DesktopUserConfigFormat = "filmos.local-user-config/v1"
const desktopUserConfigMaxBytes = 2 << 20

type DesktopUserConfigDocument struct {
	Format        string          `json:"format"`
	SchemaVersion int             `json:"schema_version"`
	EntityVersion int             `json:"entity_version"`
	ContentHash   string          `json:"content_hash"`
	CreatedAt     time.Time       `json:"created_at"`
	UpdatedAt     time.Time       `json:"updated_at"`
	Payload       json.RawMessage `json:"payload"`
}

type DesktopUserConfigWrite struct {
	ExpectedVersion     int             `json:"expected_version"`
	ExpectedContentHash string          `json:"expected_content_hash"`
	Payload             json.RawMessage `json:"payload"`
}

func (s *Service) ReadDesktopUserConfig(userID string) (DesktopUserConfigDocument, error) {
	if !s.DesktopLocalAuthEnabled() {
		return DesktopUserConfigDocument{}, Forbidden("本地用户配置只允许桌面版访问")
	}
	path, err := s.desktopUserConfigPath(userID)
	if err != nil {
		return DesktopUserConfigDocument{}, err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	return readDesktopUserConfig(path)
}

func (s *Service) WriteDesktopUserConfig(userID string, input DesktopUserConfigWrite) (DesktopUserConfigDocument, error) {
	if !s.DesktopLocalAuthEnabled() {
		return DesktopUserConfigDocument{}, Forbidden("本地用户配置只允许桌面版访问")
	}
	if input.ExpectedVersion < 0 || len(input.ExpectedContentHash) > 128 {
		return DesktopUserConfigDocument{}, NewAppError(400, "本地用户配置写入前置条件无效")
	}
	payload, err := validateDesktopUserConfigPayload(input.Payload)
	if err != nil {
		return DesktopUserConfigDocument{}, NewAppError(400, err.Error())
	}
	path, err := s.desktopUserConfigPath(userID)
	if err != nil {
		return DesktopUserConfigDocument{}, err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	current, err := readDesktopUserConfig(path)
	if err != nil {
		return DesktopUserConfigDocument{}, err
	}
	if current.EntityVersion != input.ExpectedVersion || current.ContentHash != strings.TrimSpace(input.ExpectedContentHash) {
		return DesktopUserConfigDocument{}, NewAppError(409, "本地用户配置已更新，请刷新后重试")
	}
	now := time.Now().UTC()
	createdAt := current.CreatedAt
	if createdAt.IsZero() {
		createdAt = now
	}
	next := DesktopUserConfigDocument{
		Format: DesktopUserConfigFormat, SchemaVersion: 1, EntityVersion: current.EntityVersion + 1,
		CreatedAt: createdAt, UpdatedAt: now, Payload: payload,
	}
	next.ContentHash, err = desktopUserConfigHash(next)
	if err != nil {
		return DesktopUserConfigDocument{}, err
	}
	if err := writeDesktopUserConfigAtomically(path, current, next); err != nil {
		return DesktopUserConfigDocument{}, WrapAppError(500, "保存本地用户配置失败", err)
	}
	return next, nil
}

// RollbackDesktopUserConfig restores only the prior local payload while keeping
// entity versions monotonic. It never reads or migrates a Secret repository.
func (s *Service) RollbackDesktopUserConfig(userID string, expectedVersion int, expectedContentHash string) (DesktopUserConfigDocument, error) {
	if !s.DesktopLocalAuthEnabled() {
		return DesktopUserConfigDocument{}, Forbidden("本地用户配置只允许桌面版访问")
	}
	path, err := s.desktopUserConfigPath(userID)
	if err != nil {
		return DesktopUserConfigDocument{}, err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	current, err := readDesktopUserConfig(path)
	if err != nil {
		return DesktopUserConfigDocument{}, err
	}
	if current.EntityVersion != expectedVersion || current.ContentHash != strings.TrimSpace(expectedContentHash) {
		return DesktopUserConfigDocument{}, NewAppError(409, "本地用户配置已更新，请刷新后重试")
	}
	entries, err := os.ReadDir(filepath.Join(filepath.Dir(path), "journal"))
	if err != nil {
		return DesktopUserConfigDocument{}, WrapAppError(409, "没有可回滚的本地用户配置", err)
	}
	prefix := strings.TrimSuffix(filepath.Base(path), ".json") + "-v"
	var candidates []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), prefix) && strings.HasSuffix(entry.Name(), ".json") {
			candidates = append(candidates, filepath.Join(filepath.Dir(path), "journal", entry.Name()))
		}
	}
	sort.Strings(candidates)
	if len(candidates) == 0 {
		return DesktopUserConfigDocument{}, NewAppError(409, "没有可回滚的本地用户配置")
	}
	previous, err := readDesktopUserConfig(candidates[len(candidates)-1])
	if err != nil {
		return DesktopUserConfigDocument{}, WrapAppError(500, "本地用户配置 Journal 无效", err)
	}
	now := time.Now().UTC()
	next := DesktopUserConfigDocument{
		Format: DesktopUserConfigFormat, SchemaVersion: 1, EntityVersion: current.EntityVersion + 1,
		CreatedAt: current.CreatedAt, UpdatedAt: now, Payload: previous.Payload,
	}
	if next.CreatedAt.IsZero() {
		next.CreatedAt = now
	}
	next.ContentHash, err = desktopUserConfigHash(next)
	if err != nil {
		return DesktopUserConfigDocument{}, err
	}
	if err := writeDesktopUserConfigAtomically(path, current, next); err != nil {
		return DesktopUserConfigDocument{}, WrapAppError(500, "回滚本地用户配置失败", err)
	}
	return next, nil
}

func (s *Service) desktopUserConfigPath(userID string) (string, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return "", BadAuthRequest("本地用户配置缺少用户作用域")
	}
	digest := sha256.Sum256([]byte("filmos-local-user-config\x00" + userID))
	return filepath.Join(s.dataDir, "user-config", hex.EncodeToString(digest[:])+".json"), nil
}

func emptyDesktopUserConfig() DesktopUserConfigDocument {
	payload := json.RawMessage(`{"brain_generation_routing":null}`)
	document := DesktopUserConfigDocument{Format: DesktopUserConfigFormat, SchemaVersion: 1, EntityVersion: 0, Payload: payload}
	document.ContentHash, _ = desktopUserConfigHash(document)
	return document
}

func readDesktopUserConfig(path string) (DesktopUserConfigDocument, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return emptyDesktopUserConfig(), nil
	}
	if err != nil {
		return DesktopUserConfigDocument{}, fmt.Errorf("读取本地用户配置: %w", err)
	}
	if len(data) > desktopUserConfigMaxBytes {
		return DesktopUserConfigDocument{}, errors.New("本地用户配置超过大小上限")
	}
	var document DesktopUserConfigDocument
	if err := json.Unmarshal(data, &document); err != nil || document.Format != DesktopUserConfigFormat || document.SchemaVersion != 1 || document.EntityVersion < 0 {
		return DesktopUserConfigDocument{}, errors.New("本地用户配置合同无效")
	}
	expected, err := desktopUserConfigHash(document)
	if err != nil || expected != document.ContentHash {
		return DesktopUserConfigDocument{}, errors.New("本地用户配置完整性校验失败")
	}
	if _, err := validateDesktopUserConfigPayload(document.Payload); err != nil {
		return DesktopUserConfigDocument{}, err
	}
	return document, nil
}

func validateDesktopUserConfigPayload(input json.RawMessage) (json.RawMessage, error) {
	if len(input) == 0 || len(input) > desktopUserConfigMaxBytes {
		return nil, errors.New("本地用户配置内容无效")
	}
	var value any
	if err := json.Unmarshal(input, &value); err != nil {
		return nil, errors.New("本地用户配置必须是有效 JSON")
	}
	if _, ok := value.(map[string]any); !ok {
		return nil, errors.New("本地用户配置必须是对象")
	}
	if secretPath := findForbiddenConfigSecret(value, "payload"); secretPath != "" {
		return nil, fmt.Errorf("本地用户配置禁止保存 Secret 字段: %s", secretPath)
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return nil, errors.New("本地用户配置无法规范化")
	}
	return canonical, nil
}

func findForbiddenConfigSecret(value any, path string) string {
	forbidden := map[string]bool{"apikey": true, "api_key": true, "cookie": true, "token": true, "runtimekey": true, "runtime_key": true, "password": true, "secret": true, "secretkey": true, "secret_key": true, "aliasmapping": true, "alias_mapping": true}
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			normalized := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "-", "_"), " ", ""))
			if forbidden[normalized] {
				return path + "." + key
			}
			if found := findForbiddenConfigSecret(typed[key], path+"."+key); found != "" {
				return found
			}
		}
	case []any:
		for index, item := range typed {
			if found := findForbiddenConfigSecret(item, fmt.Sprintf("%s[%d]", path, index)); found != "" {
				return found
			}
		}
	}
	return ""
}

func desktopUserConfigHash(document DesktopUserConfigDocument) (string, error) {
	projection := struct {
		Format        string          `json:"format"`
		SchemaVersion int             `json:"schema_version"`
		EntityVersion int             `json:"entity_version"`
		CreatedAt     time.Time       `json:"created_at"`
		UpdatedAt     time.Time       `json:"updated_at"`
		Payload       json.RawMessage `json:"payload"`
	}{document.Format, document.SchemaVersion, document.EntityVersion, document.CreatedAt, document.UpdatedAt, document.Payload}
	data, err := json.Marshal(projection)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(append([]byte("filmos:desktop-user-config:envelope:v1\x00"), data...))
	return hex.EncodeToString(digest[:]), nil
}

func writeDesktopUserConfigAtomically(path string, previous, next DesktopUserConfigDocument) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(filepath.Join(directory, "journal"), 0o700); err != nil {
		return err
	}
	previousData, err := json.Marshal(previous)
	if err != nil {
		return err
	}
	journal := filepath.Join(directory, "journal", fmt.Sprintf("%s-v%020d-%020d.json", strings.TrimSuffix(filepath.Base(path), ".json"), previous.EntityVersion, time.Now().UnixNano()))
	if err := os.WriteFile(journal, previousData, 0o600); err != nil {
		return err
	}
	data, err := json.Marshal(next)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".user-config-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
