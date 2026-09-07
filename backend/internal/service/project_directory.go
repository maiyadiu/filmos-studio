package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/projectfs"
)

func (s *Service) RelocateProjectDirectory(ctx context.Context, userID, projectID string) (ProjectDirectoryStatus, error) {
	native, err := s.directoryNative()
	if err != nil {
		return ProjectDirectoryStatus{}, err
	}
	if _, err = s.repo.ProjectForUser(userID, projectID); err != nil {
		return ProjectDirectoryStatus{}, err
	}
	row, err := s.repo.ProjectDirectory(userID, projectID)
	if err != nil {
		return ProjectDirectoryStatus{}, err
	}
	if _, e := os.Lstat(row.RootPath); !errors.Is(e, os.ErrNotExist) {
		return ProjectDirectoryStatus{}, NewAppError(409, "原目录仍存在，请先处理原目录问题；不能创建第二份活动副本")
	}
	if !s.projectDirectoryPickerMu.TryLock() {
		return ProjectDirectoryStatus{}, NewAppError(409, "目录选择器已经打开")
	}
	defer s.projectDirectoryPickerMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	selected, err := native.Choose(ctx, true)
	if err != nil {
		return ProjectDirectoryStatus{}, NewAppError(503, "重新定位未完成")
	}
	if selected == "" {
		return s.ProjectDirectoryStatus(userID, projectID)
	}
	selected, err = filepath.EvalSymlinks(selected)
	if err != nil {
		return ProjectDirectoryStatus{}, NewAppError(409, "所选目录不可用")
	}
	if _, err = projectfs.ValidateParent(filepath.Dir(selected), s.directoryForbidden()); err != nil {
		return ProjectDirectoryStatus{}, NewAppError(409, err.Error())
	}
	s.projectDirectoryMu.Lock()
	defer s.projectDirectoryMu.Unlock()
	if _, e := os.Lstat(row.RootPath); !errors.Is(e, os.ErrNotExist) {
		return ProjectDirectoryStatus{}, NewAppError(409, "原目录重新出现，重新定位已停止")
	}
	if err = projectfs.Check(selected, projectID); err != nil {
		return ProjectDirectoryStatus{}, NewAppError(409, "所选目录不是完整的原项目："+err.Error())
	}
	if err = s.repo.RelocateProjectDirectory(userID, projectID, row.RootPath, selected); err != nil {
		return ProjectDirectoryStatus{}, err
	}
	row.RootPath = selected
	if err = s.syncProjectDirectoryLocked(userID, row); err != nil {
		return ProjectDirectoryStatus{}, NewAppError(503, "位置已关联，但同步仍需重试："+err.Error())
	}
	return ProjectDirectoryStatus{Managed: true, Path: selected, State: "ready"}, nil
}

type ProjectDirectoryStatus struct {
	Managed bool   `json:"managed"`
	Path    string `json:"path,omitempty"`
	State   string `json:"state"`
	Message string `json:"message,omitempty"`
}

func (s *Service) CreateProject(userID string, req CreateProjectRequest) (model.Project, error) {
	if !s.DesktopLocalAuthEnabled() {
		if req.LocalDirectory != nil {
			return model.Project{}, NewAppError(403, "公开部署不能指定本机作品目录")
		}
		return s.createProjectRecord(userID, req, newID())
	}
	if _, err := s.directoryNative(); err != nil {
		return model.Project{}, err
	}
	local := req.LocalDirectory
	if local == nil || strings.TrimSpace(local.RequestID) == "" || len(local.RequestID) > 100 {
		return model.Project{}, BadAuthRequest("创建本机作品需要稳定的创建请求标识")
	}
	s.projectDirectoryMu.Lock()
	defer s.projectDirectoryMu.Unlock()
	hash := directoryRequestHash(req)
	row, err := s.repo.ProjectDirectoryRequest(userID, local.RequestID)
	resume := err == nil
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return model.Project{}, err
	}
	if resume && row.RequestHash != hash {
		return model.Project{}, NewAppError(409, "此创建请求已绑定另一份项目，未重复创建")
	}
	if !resume {
		if _, e := projectfs.ChildName(req.Name, "00000000"); e != nil {
			return model.Project{}, BadAuthRequest(e.Error())
		}
		style, e := validateStyleProfileJSON(req.StyleProfileJSON)
		if e != nil {
			return model.Project{}, BadAuthRequest(e.Error())
		}
		if e = validateStyleProfilePreset(strings.TrimSpace(req.StylePresetID), style); e != nil {
			return model.Project{}, BadAuthRequest(e.Error())
		}
		if exists, e := s.repo.ProjectNameExists(userID, strings.TrimSpace(req.Name)); e != nil {
			return model.Project{}, e
		} else if exists {
			return model.Project{}, NewAppError(409, "项目名称已存在，请修改名称后重试（未创建目录）")
		}
		parent, e := s.selectedProjectParent(context.Background(), userID, local.LocationToken)
		if e != nil {
			return model.Project{}, NewAppError(409, e.Error())
		}
		id := directoryProjectID(userID, local.RequestID)
		child, e := projectfs.ChildName(req.Name, id)
		if e != nil {
			return model.Project{}, BadAuthRequest(e.Error())
		}
		now := time.Now()
		row = model.ProjectDirectory{ProjectID: id, UserID: userID, RequestID: local.RequestID, RequestHash: hash, RootPath: filepath.Join(parent, child), State: "initializing", CreatedAt: now, UpdatedAt: now}
		if e = s.repo.ReserveProjectDirectory(row); e != nil {
			return model.Project{}, e
		}
		row, e = s.repo.ProjectDirectoryRequest(userID, local.RequestID)
		if e != nil {
			return model.Project{}, e
		}
		if row.RequestHash != hash {
			return model.Project{}, NewAppError(409, "创建请求冲突")
		}
	} else if local.LocationToken != "" {
		if g, ok := s.projectDirectoryGrants[local.LocationToken]; ok && g.UserID == userID && g.Path != filepath.Dir(row.RootPath) {
			return model.Project{}, NewAppError(409, "不能用同一请求改换项目保存位置")
		}
	}
	if row.State == "initializing" {
		if err = projectfs.Initialize(filepath.Dir(row.RootPath), filepath.Base(row.RootPath), row.ProjectID, req.Name, resume); err != nil {
			return model.Project{}, NewAppError(409, err.Error())
		}
	} else if err = projectfs.Check(row.RootPath, row.ProjectID); err != nil {
		return model.Project{}, NewAppError(409, err.Error())
	}
	project, err := s.repo.ProjectForUser(userID, row.ProjectID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		if row.State != "initializing" {
			return model.Project{}, NewAppError(410, "原项目记录已移除，不会通过旧创建请求自动重建")
		}
		created, e := s.createProjectRecord(userID, req, row.ProjectID)
		if e != nil {
			return model.Project{}, e
		}
		project = &created
	} else if err != nil {
		return model.Project{}, err
	}
	if row.State == "initializing" {
		// Recovery may find the project row committed before workflow creation.
		if err = s.EnsureBuiltinProjectWorkflowTemplate(); err != nil {
			return *project, err
		}
		if _, err = s.createProjectWorkflow(project.ID, "", "project"); err != nil {
			return *project, err
		}
		project, err = s.repo.ProjectForUser(userID, project.ID)
		if err != nil {
			return model.Project{}, err
		}
	}
	if err = s.syncProjectDirectoryLocked(userID, row); err != nil {
		return *project, WrapAppError(503, "项目已建立，但作品目录未同步完成；请使用原请求重试，不能新建副本", err)
	}
	return *project, nil
}

func directoryProjectID(userID, requestID string) string {
	h := projectfs.Hash([]byte(userID + "\x00" + requestID))
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func (s *Service) ProjectDirectoryStatus(userID, projectID string) (ProjectDirectoryStatus, error) {
	s.projectDirectoryMu.Lock()
	defer s.projectDirectoryMu.Unlock()
	if _, err := s.repo.ProjectForUser(userID, projectID); err != nil {
		return ProjectDirectoryStatus{}, err
	}
	row, err := s.repo.ProjectDirectory(userID, projectID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ProjectDirectoryStatus{State: "legacy"}, nil
	}
	if err != nil {
		return ProjectDirectoryStatus{}, err
	}
	status := ProjectDirectoryStatus{Managed: true, State: row.State}
	if !s.DesktopLocalAuthEnabled() {
		return status, nil
	}
	status.Path = row.RootPath
	if err = projectfs.Check(row.RootPath, row.ProjectID); err != nil {
		status.State = "unavailable"
		status.Message = err.Error()
	}
	return status, nil
}

func (s *Service) OpenProjectDirectory(ctx context.Context, userID, projectID string) error {
	native, err := s.directoryNative()
	if err != nil {
		return err
	}
	status, err := s.ProjectDirectoryStatus(userID, projectID)
	if err != nil {
		return err
	}
	if !status.Managed || status.State == "unavailable" {
		return NewAppError(409, "作品目录未关联或不可访问")
	}
	return native.Open(ctx, status.Path)
}

func (s *Service) SyncProjectDirectory(userID, projectID string) error {
	if !s.DesktopLocalAuthEnabled() {
		return NewAppError(403, "仅限本机作品目录")
	}
	if _, err := s.repo.ProjectForUser(userID, projectID); err != nil {
		return err
	}
	s.projectDirectoryMu.Lock()
	defer s.projectDirectoryMu.Unlock()
	row, err := s.repo.ProjectDirectory(userID, projectID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.syncProjectDirectoryLocked(userID, row)
}

type ProjectDirectoryExport struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

func (s *Service) ExportProjectDirectory(userID, projectID string) (ProjectDirectoryExport, error) {
	if !s.DesktopLocalAuthEnabled() {
		return ProjectDirectoryExport{}, NewAppError(403, "仅限本机作品目录")
	}
	if _, err := s.repo.ProjectForUser(userID, projectID); err != nil {
		return ProjectDirectoryExport{}, err
	}
	s.projectDirectoryMu.Lock()
	defer s.projectDirectoryMu.Unlock()
	row, err := s.repo.ProjectDirectory(userID, projectID)
	if err != nil {
		return ProjectDirectoryExport{}, err
	}
	if err = s.syncProjectDirectoryLocked(userID, row); err != nil {
		return ProjectDirectoryExport{}, err
	}
	path, digest, err := projectfs.Export(row.RootPath, projectID)
	return ProjectDirectoryExport{Path: filepath.Join(row.RootPath, path), SHA256: digest}, err
}

func (s *Service) syncProjectDirectoryLocked(userID string, row model.ProjectDirectory) error {
	files, name, err := s.projectDirectoryFiles(userID, row.ProjectID)
	if err == nil {
		err = projectfs.SyncFiles(row.RootPath, row.ProjectID, name, files)
	}
	state := "ready"
	if err != nil {
		state = "sync_failed"
	}
	if e := s.repo.SetProjectDirectoryState(userID, row.ProjectID, state); e != nil {
		return errors.Join(err, e)
	}
	return err
}

// Acquire before any database write, and release after materialization. A lost
// disk is a write blocker, not permission to create a second local copy.
func (s *Service) beginProjectDirectoryWrite(userID, projectID string) (func(*error), error) {
	return s.beginProjectDirectoryChanges(userID, func() ([]string, error) { return []string{projectID}, nil })
}

func (s *Service) beginProjectAssetDirectoryWrite(userID, projectID, assetID string) (func(*error), error) {
	return s.beginProjectDirectoryChanges(userID, func() ([]string, error) {
		ids, err := s.repo.ProjectIDsForAssets(userID, []string{assetID})
		return append(ids, projectID), err
	})
}

func (s *Service) beginProjectDirectoryChanges(userID string, selectProjects func() ([]string, error)) (func(*error), error) {
	noop := func(*error) {}
	if !s.DesktopLocalAuthEnabled() {
		return noop, nil
	}
	s.projectDirectoryMu.Lock()
	ids, err := selectProjects()
	rows := []model.ProjectDirectory{}
	seen := map[string]bool{}
	for _, id := range ids {
		if err != nil {
			break
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		var row model.ProjectDirectory
		row, err = s.repo.ProjectDirectory(userID, id)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			err = nil
			continue
		}
		if err == nil {
			err = projectfs.Check(row.RootPath, row.ProjectID)
		}
		if err == nil {
			rows = append(rows, row)
		}
	}
	for _, row := range rows {
		if err != nil {
			break
		}
		err = s.repo.SetProjectDirectoryState(userID, row.ProjectID, "pending")
	}
	if err != nil {
		s.projectDirectoryMu.Unlock()
		return nil, NewAppError(409, "作品目录不可写，修改未开始："+err.Error())
	}
	return func(resultErr *error) {
		defer s.projectDirectoryMu.Unlock()
		// Some existing services can persist a part before returning an error.
		// Always materialize the actual committed state, preserving the original error.
		for _, row := range rows {
			if err := s.syncProjectDirectoryLocked(userID, row); err != nil {
				*resultErr = errors.Join(*resultErr, NewAppError(503, "业务记录可能已保存，但作品目录同步未完成；请回读后重试目录同步，不要重复创建内容。"+err.Error()))
			}
		}
	}, nil
}
