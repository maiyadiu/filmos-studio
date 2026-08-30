package service

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const DesktopBackupFormat = "filmos.local-backup/v1"

type DesktopBackupEntry struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type DesktopBackupManifest struct {
	Format             string               `json:"format"`
	CreatedAt          time.Time            `json:"created_at"`
	Application        string               `json:"application"`
	ApplicationVersion string               `json:"application_version,omitempty"`
	UserID             string               `json:"user_id"`
	Database           string               `json:"database"`
	Entries            []DesktopBackupEntry `json:"entries"`
	Excluded           []string             `json:"excluded"`
}

type DesktopBackupArtifact struct {
	Path     string
	Filename string
	SHA256   string
	Size     int64
	Manifest DesktopBackupManifest
}

type desktopBackupSource struct {
	archivePath string
	filePath    string
	entry       DesktopBackupEntry
}

func (s *Service) CreateDesktopBackup(userID string, applicationVersion string) (DesktopBackupArtifact, error) {
	if !s.DesktopLocalAuthEnabled() {
		return DesktopBackupArtifact{}, Forbidden("只有本地桌面版可以导出 FilmOS 备份包")
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return DesktopBackupArtifact{}, BadAuthRequest("备份缺少本地用户作用域")
	}
	if s.repo.Dialect() != "sqlite" {
		return DesktopBackupArtifact{}, BadAuthRequest("本地备份只支持 SQLite 数据目录")
	}

	s.storageMu.Lock()
	defer s.storageMu.Unlock()

	backupDirectory := filepath.Join(s.dataDir, "backups")
	if err := os.MkdirAll(backupDirectory, 0o700); err != nil {
		return DesktopBackupArtifact{}, fmt.Errorf("创建备份目录: %w", err)
	}
	snapshotHandle, err := os.CreateTemp(backupDirectory, ".filmos-snapshot-*.db")
	if err != nil {
		return DesktopBackupArtifact{}, fmt.Errorf("准备数据库快照: %w", err)
	}
	snapshotPath := snapshotHandle.Name()
	if err := snapshotHandle.Close(); err != nil {
		return DesktopBackupArtifact{}, err
	}
	if err := os.Remove(snapshotPath); err != nil {
		return DesktopBackupArtifact{}, err
	}
	defer os.Remove(snapshotPath)
	if err := s.repo.BackupSQLite(snapshotPath); err != nil {
		return DesktopBackupArtifact{}, fmt.Errorf("创建 SQLite 一致性快照: %w", err)
	}

	createdAt := time.Now().UTC()
	manifest, sources, err := collectDesktopBackupSources(snapshotPath, filepath.Join(s.dataDir, "resources"), filepath.Join(s.dataDir, "user-config"), userID, strings.TrimSpace(applicationVersion), createdAt)
	if err != nil {
		return DesktopBackupArtifact{}, err
	}
	packageHandle, err := os.CreateTemp(backupDirectory, ".filmos-export-*.filmosbackup")
	if err != nil {
		return DesktopBackupArtifact{}, fmt.Errorf("创建备份包: %w", err)
	}
	packagePath := packageHandle.Name()
	if err := writeDesktopBackupPackage(packageHandle, manifest, sources, createdAt); err != nil {
		packageHandle.Close()
		os.Remove(packagePath)
		return DesktopBackupArtifact{}, err
	}
	if err := packageHandle.Close(); err != nil {
		os.Remove(packagePath)
		return DesktopBackupArtifact{}, err
	}
	packageHash, size, err := hashFile(packagePath)
	if err != nil {
		os.Remove(packagePath)
		return DesktopBackupArtifact{}, err
	}
	return DesktopBackupArtifact{
		Path:     packagePath,
		Filename: "FilmOS备份-" + createdAt.Format("20060102-150405") + ".filmosbackup",
		SHA256:   packageHash,
		Size:     size,
		Manifest: manifest,
	}, nil
}

func VerifyDesktopBackupPackage(filename string) (DesktopBackupManifest, error) {
	reader, err := zip.OpenReader(filename)
	if err != nil {
		return DesktopBackupManifest{}, fmt.Errorf("打开 FilmOS 备份包: %w", err)
	}
	defer reader.Close()
	files := make(map[string]*zip.File, len(reader.File))
	for _, file := range reader.File {
		if file.FileInfo().IsDir() || file.Mode()&os.ModeSymlink != 0 || !validDesktopBackupPath(file.Name) {
			return DesktopBackupManifest{}, fmt.Errorf("备份包包含无效路径 %q", file.Name)
		}
		if _, exists := files[file.Name]; exists {
			return DesktopBackupManifest{}, fmt.Errorf("备份包包含重复路径 %q", file.Name)
		}
		files[file.Name] = file
	}
	manifestFile := files["manifest.json"]
	if manifestFile == nil || manifestFile.UncompressedSize64 > 8<<20 {
		return DesktopBackupManifest{}, errors.New("备份包缺少有效 manifest.json")
	}
	stream, err := manifestFile.Open()
	if err != nil {
		return DesktopBackupManifest{}, err
	}
	manifestBytes, readErr := io.ReadAll(stream)
	closeErr := stream.Close()
	if readErr != nil {
		return DesktopBackupManifest{}, readErr
	}
	if closeErr != nil {
		return DesktopBackupManifest{}, closeErr
	}
	var manifest DesktopBackupManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil || manifest.Format != DesktopBackupFormat || manifest.Database != "database/open_ai_canvas.db" {
		return DesktopBackupManifest{}, errors.New("备份包 manifest 合同无效")
	}
	if len(files) != len(manifest.Entries)+1 {
		return DesktopBackupManifest{}, errors.New("备份包文件数与 manifest 不一致")
	}
	seen := make(map[string]bool, len(manifest.Entries))
	for _, expected := range manifest.Entries {
		if seen[expected.Path] || !validDesktopBackupPath(expected.Path) || expected.Path == "manifest.json" {
			return DesktopBackupManifest{}, errors.New("备份包 manifest 包含无效文件记录")
		}
		seen[expected.Path] = true
		file := files[expected.Path]
		if file == nil || int64(file.UncompressedSize64) != expected.Size {
			return DesktopBackupManifest{}, fmt.Errorf("备份文件 %q 大小不一致", expected.Path)
		}
		stream, err := file.Open()
		if err != nil {
			return DesktopBackupManifest{}, err
		}
		digest := sha256.New()
		_, copyErr := io.Copy(digest, stream)
		closeErr := stream.Close()
		if copyErr != nil {
			return DesktopBackupManifest{}, copyErr
		}
		if closeErr != nil {
			return DesktopBackupManifest{}, closeErr
		}
		if hex.EncodeToString(digest.Sum(nil)) != expected.SHA256 {
			return DesktopBackupManifest{}, fmt.Errorf("备份文件 %q 哈希不一致", expected.Path)
		}
	}
	return manifest, nil
}

func collectDesktopBackupSources(snapshotPath, resourcesRoot, userConfigRoot, userID, applicationVersion string, createdAt time.Time) (DesktopBackupManifest, []desktopBackupSource, error) {
	sources := make([]desktopBackupSource, 0)
	databaseEntry, err := desktopBackupSourceFor("database/open_ai_canvas.db", snapshotPath)
	if err != nil {
		return DesktopBackupManifest{}, nil, err
	}
	sources = append(sources, databaseEntry)
	if info, err := os.Stat(resourcesRoot); err == nil && info.IsDir() {
		err = filepath.WalkDir(resourcesRoot, func(filename string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
				return fmt.Errorf("资源目录包含非常规文件: %s", filepath.Base(filename))
			}
			relative, err := filepath.Rel(resourcesRoot, filename)
			if err != nil {
				return err
			}
			source, err := desktopBackupSourceFor(path.Join("resources", filepath.ToSlash(relative)), filename)
			if err != nil {
				return err
			}
			sources = append(sources, source)
			return nil
		})
		if err != nil {
			return DesktopBackupManifest{}, nil, err
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return DesktopBackupManifest{}, nil, err
	}
	if entries, err := os.ReadDir(userConfigRoot); err == nil {
		for _, entry := range entries {
			if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
				continue
			}
			filename := filepath.Join(userConfigRoot, entry.Name())
			if info, statErr := entry.Info(); statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
				return DesktopBackupManifest{}, nil, errors.New("本地用户配置包含非常规文件")
			}
			data, readErr := os.ReadFile(filename)
			if readErr != nil {
				return DesktopBackupManifest{}, nil, readErr
			}
			var document DesktopUserConfigDocument
			if json.Unmarshal(data, &document) != nil || document.Format != DesktopUserConfigFormat {
				return DesktopBackupManifest{}, nil, errors.New("本地用户配置备份合同无效")
			}
			if _, validationErr := validateDesktopUserConfigPayload(document.Payload); validationErr != nil {
				return DesktopBackupManifest{}, nil, validationErr
			}
			source, sourceErr := desktopBackupSourceFor(path.Join("user-config", entry.Name()), filename)
			if sourceErr != nil {
				return DesktopBackupManifest{}, nil, sourceErr
			}
			sources = append(sources, source)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return DesktopBackupManifest{}, nil, err
	}
	sort.Slice(sources, func(i, j int) bool { return sources[i].archivePath < sources[j].archivePath })
	entries := make([]DesktopBackupEntry, len(sources))
	for index, source := range sources {
		entries[index] = source.entry
	}
	return DesktopBackupManifest{
		Format:             DesktopBackupFormat,
		CreatedAt:          createdAt,
		Application:        "FilmOS Studio",
		ApplicationVersion: applicationVersion,
		UserID:             userID,
		Database:           "database/open_ai_canvas.db",
		Entries:            entries,
		Excluded: []string{
			"api keys and credential encryption key",
			"cookies and CLI login credentials",
			"temporary session uploads",
			"user-config journals (current validated authority only)",
			"WebKit rebuildable local cache",
		},
	}, sources, nil
}

func desktopBackupSourceFor(archivePath, filename string) (desktopBackupSource, error) {
	if !validDesktopBackupPath(archivePath) || archivePath == "manifest.json" {
		return desktopBackupSource{}, fmt.Errorf("备份路径无效: %s", archivePath)
	}
	hash, size, err := hashFile(filename)
	if err != nil {
		return desktopBackupSource{}, err
	}
	return desktopBackupSource{
		archivePath: archivePath,
		filePath:    filename,
		entry:       DesktopBackupEntry{Path: archivePath, Size: size, SHA256: hash},
	}, nil
}

func writeDesktopBackupPackage(output *os.File, manifest DesktopBackupManifest, sources []desktopBackupSource, createdAt time.Time) error {
	writer := zip.NewWriter(output)
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	manifestBytes = append(manifestBytes, '\n')
	if err := writeDesktopBackupBytes(writer, "manifest.json", manifestBytes, createdAt); err != nil {
		return err
	}
	for _, source := range sources {
		if err := writeDesktopBackupFile(writer, source, createdAt); err != nil {
			return err
		}
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("完成备份包: %w", err)
	}
	return output.Sync()
}

func writeDesktopBackupBytes(writer *zip.Writer, filename string, content []byte, modified time.Time) error {
	header := &zip.FileHeader{Name: filename, Method: zip.Deflate, Modified: modified}
	header.SetMode(0o600)
	entry, err := writer.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = entry.Write(content)
	return err
}

func writeDesktopBackupFile(writer *zip.Writer, source desktopBackupSource, modified time.Time) error {
	header := &zip.FileHeader{Name: source.archivePath, Method: zip.Deflate, Modified: modified}
	header.SetMode(0o600)
	entry, err := writer.CreateHeader(header)
	if err != nil {
		return err
	}
	file, err := os.Open(source.filePath)
	if err != nil {
		return err
	}
	defer file.Close()
	digest := sha256.New()
	written, err := io.Copy(io.MultiWriter(entry, digest), file)
	if err != nil {
		return err
	}
	if written != source.entry.Size || hex.EncodeToString(digest.Sum(nil)) != source.entry.SHA256 {
		return fmt.Errorf("备份时文件发生变化: %s", source.archivePath)
	}
	return nil
}

func hashFile(filename string) (string, int64, error) {
	file, err := os.Open(filename)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	digest := sha256.New()
	size, err := io.Copy(digest, file)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(digest.Sum(nil)), size, nil
}

func validDesktopBackupPath(value string) bool {
	return value != "" && !strings.Contains(value, "\\") && !strings.HasPrefix(value, "/") && path.Clean(value) == value && value != ".." && !strings.HasPrefix(value, "../")
}
