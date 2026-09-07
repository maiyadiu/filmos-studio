package service

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/projectfs"
)

type ProjectDirectoryPlatform interface {
	Downloads(context.Context) (string, error)
	Choose(context.Context, bool) (string, error)
	Open(context.Context, string) error
}

// Platform dependencies are supplied by trusted startup code, never HTTP.
func (s *Service) SetProjectDirectoryPlatform(platform ProjectDirectoryPlatform) {
	s.projectDirectoryNative = platform
}

type macProjectDirectoryNative struct{}

func NativeProjectDirectoryPlatform() (ProjectDirectoryPlatform, error) {
	if runtime.GOOS != "darwin" {
		return nil, NewAppError(503, "当前系统尚未接通可信本机目录选择器")
	}
	return macProjectDirectoryNative{}, nil
}

func (macProjectDirectoryNative) Downloads(ctx context.Context) (string, error) {
	b, err := exec.CommandContext(ctx, "/usr/bin/osascript", "-e", "POSIX path of (path to downloads folder)").Output()
	return strings.TrimSpace(string(b)), err
}
func (macProjectDirectoryNative) Choose(ctx context.Context, existing bool) (string, error) {
	prompt := "选择 FilmOS 新项目的保存位置（将在其中创建独立项目目录）"
	if existing {
		prompt = "选择移动后的原作品目录（其中须有项目.json）；不会复制或迁移文件"
	}
	b, err := exec.CommandContext(ctx, "/usr/bin/osascript", "-e", `tell application "Finder"
activate
try
return POSIX path of (choose folder with prompt "`+prompt+`")
on error number -128
return ""
end try
end tell`).Output()
	return strings.TrimSpace(string(b)), err
}
func (macProjectDirectoryNative) Open(ctx context.Context, path string) error {
	return exec.CommandContext(ctx, "/usr/bin/open", "-R", filepath.Join(path, "项目.json")).Run()
}

type projectDirectoryGrant struct {
	UserID, Path string
	ExpiresAt    time.Time
	Identity     os.FileInfo
}
type ProjectDirectoryLocation struct {
	Enabled        bool   `json:"enabled"`
	DefaultParent  string `json:"defaultParent,omitempty"`
	SelectedParent string `json:"selectedParent,omitempty"`
	LocationToken  string `json:"locationToken,omitempty"`
	Cancelled      bool   `json:"cancelled,omitempty"`
}

func (s *Service) directoryNative() (ProjectDirectoryPlatform, error) {
	if !s.DesktopLocalAuthEnabled() {
		return nil, NewAppError(403, "本机作品目录仅限本地源码工作台")
	}
	if s.projectDirectoryNative != nil {
		return s.projectDirectoryNative, nil
	}
	return NativeProjectDirectoryPlatform()
}

func (s *Service) directoryForbidden() []string {
	home, _ := os.UserHomeDir()
	paths := []string{s.dataDir, os.Getenv("FILMOS_DESKTOP_SOURCE_ROOT"), os.Getenv("FILMOS_DESKTOP_SOURCE_RUNTIME_ROOT")}
	if home != "" {
		for _, p := range []string{"Library", ".ssh", ".codex", ".config", "Applications"} {
			paths = append(paths, filepath.Join(home, p))
		}
	}
	// Direct backend development also must not create projects inside its checkout.
	if cwd, e := os.Getwd(); e == nil {
		for p := cwd; ; p = filepath.Dir(p) {
			if _, e = os.Stat(filepath.Join(p, "backend", "go.mod")); e == nil {
				paths = append(paths, p)
				break
			}
			if filepath.Dir(p) == p {
				break
			}
		}
	}
	return paths
}

func (s *Service) ProjectDirectoryLocation(ctx context.Context, userID string) (ProjectDirectoryLocation, error) {
	if !s.DesktopLocalAuthEnabled() {
		return ProjectDirectoryLocation{Enabled: false}, nil
	}
	native, err := s.directoryNative()
	if err != nil {
		return ProjectDirectoryLocation{}, err
	}
	key := "project-directory-default:" + userID
	setting, err := s.repo.SystemSetting(key)
	if err == nil {
		var path string
		if json.Unmarshal([]byte(setting.ValueJSON), &path) != nil || !filepath.IsAbs(path) {
			return ProjectDirectoryLocation{}, NewAppError(503, "默认项目位置配置无效")
		}
		return ProjectDirectoryLocation{Enabled: true, DefaultParent: path}, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return ProjectDirectoryLocation{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	downloads, err := native.Downloads(ctx)
	if err != nil {
		return ProjectDirectoryLocation{}, NewAppError(503, "无法读取系统下载目录")
	}
	if !filepath.IsAbs(downloads) {
		return ProjectDirectoryLocation{}, NewAppError(503, "系统下载目录无效")
	}
	return ProjectDirectoryLocation{Enabled: true, DefaultParent: downloads}, nil
}

func (s *Service) ChooseProjectDirectory(ctx context.Context, userID string) (ProjectDirectoryLocation, error) {
	native, err := s.directoryNative()
	if err != nil {
		return ProjectDirectoryLocation{}, err
	}
	if !s.projectDirectoryPickerMu.TryLock() {
		return ProjectDirectoryLocation{}, NewAppError(409, "目录选择器已经打开")
	}
	defer s.projectDirectoryPickerMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	path, err := native.Choose(ctx, false)
	if err != nil {
		return ProjectDirectoryLocation{}, NewAppError(503, "目录选择未完成，请重试")
	}
	if path == "" {
		return ProjectDirectoryLocation{Enabled: true, Cancelled: true}, nil
	}
	path, err = projectfs.ValidateParent(path, s.directoryForbidden())
	if err != nil {
		return ProjectDirectoryLocation{}, NewAppError(400, err.Error())
	}
	s.projectDirectoryMu.Lock()
	defer s.projectDirectoryMu.Unlock()
	if s.projectDirectoryGrants == nil {
		s.projectDirectoryGrants = map[string]projectDirectoryGrant{}
	}
	for key, g := range s.projectDirectoryGrants {
		if time.Now().After(g.ExpiresAt) {
			delete(s.projectDirectoryGrants, key)
		}
	}
	token := newID()
	identity, err := os.Stat(path)
	if err != nil {
		return ProjectDirectoryLocation{}, err
	}
	s.projectDirectoryGrants[token] = projectDirectoryGrant{UserID: userID, Path: path, ExpiresAt: time.Now().Add(15 * time.Minute), Identity: identity}
	return ProjectDirectoryLocation{Enabled: true, SelectedParent: path, LocationToken: token}, nil
}

func (s *Service) selectedProjectParent(ctx context.Context, userID, token string) (string, error) {
	if token != "" {
		g, ok := s.projectDirectoryGrants[token]
		if !ok || g.UserID != userID || time.Now().After(g.ExpiresAt) {
			return "", NewAppError(409, "目录选择已失效，请重新选择；未创建项目")
		}
		path, err := projectfs.ValidateParent(g.Path, s.directoryForbidden())
		if err != nil {
			return "", err
		}
		current, err := os.Stat(path)
		if err != nil || path != g.Path || g.Identity == nil || !os.SameFile(g.Identity, current) {
			return "", NewAppError(409, "所选目录身份已变化，请重新选择")
		}
		return path, nil
	}
	location, err := s.ProjectDirectoryLocation(ctx, userID)
	if err != nil {
		return "", err
	}
	return projectfs.ValidateParent(location.DefaultParent, s.directoryForbidden())
}

func (s *Service) SetDefaultProjectDirectory(ctx context.Context, userID, token string) (ProjectDirectoryLocation, error) {
	if _, err := s.directoryNative(); err != nil {
		return ProjectDirectoryLocation{}, err
	}
	s.projectDirectoryMu.Lock()
	defer s.projectDirectoryMu.Unlock()
	path, err := s.selectedProjectParent(ctx, userID, token)
	if err != nil {
		return ProjectDirectoryLocation{}, err
	}
	if token == "" {
		return ProjectDirectoryLocation{}, BadAuthRequest("请先通过系统选择器选择目录")
	}
	b, _ := json.Marshal(path)
	err = s.repo.SaveSystemSetting(&model.SystemSetting{Key: "project-directory-default:" + userID, ValueJSON: string(b), UpdatedBy: userID, UpdatedAt: time.Now()})
	return ProjectDirectoryLocation{Enabled: true, DefaultParent: path}, err
}

type CreateProjectDirectoryRequest struct {
	RequestID     string `json:"requestId"`
	LocationToken string `json:"locationToken,omitempty"`
}

func directoryRequestHash(req CreateProjectRequest) string {
	// The grant expires; it is not part of the durable logical create identity.
	copy := req
	if req.LocalDirectory != nil {
		local := *req.LocalDirectory
		local.LocationToken = ""
		copy.LocalDirectory = &local
	}
	b, _ := json.Marshal(copy)
	return projectfs.Hash(b)
}
