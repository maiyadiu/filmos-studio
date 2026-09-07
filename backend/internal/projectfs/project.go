// Package projectfs manages FilmOS-owned files beneath an explicitly selected
// project directory. It never treats a user-selected parent as disposable.
package projectfs

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var Folders = []string{"剧本", "设定", "分镜", "提示词", "素材", "生成", "导出", "历史"}

type Manifest struct {
	SchemaVersion int               `json:"schemaVersion"`
	ProjectID     string            `json:"projectId"`
	Name          string            `json:"name"`
	Authority     string            `json:"authority"`
	Files         map[string]string `json:"files"`
	Pending       *PendingWrite     `json:"pending,omitempty"`
	CurrentFiles  []string          `json:"currentFiles"`
}

type PendingWrite struct {
	File   string `json:"file"`
	Before string `json:"before"`
	After  string `json:"after"`
}

func Hash(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func ChildName(name, id string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 80 || strings.HasPrefix(name, ".") || strings.ContainsAny(name, "/\\:\x00\r\n\t") || strings.HasSuffix(name, ".") {
		return "", errors.New("项目名称不能用作目录名，请使用不超过80字且不含路径符号的名称")
	}
	if len(id) < 8 || strings.ContainsAny(id, "/\\") {
		return "", errors.New("项目身份无效")
	}
	return name + "-" + id[:8], nil
}

// ValidateParent resolves the OS aliases (e.g. macOS /var), then rejects a
// selected directory inside an application root or another FilmOS project.
func ValidateParent(value string, forbidden []string) (string, error) {
	if !filepath.IsAbs(value) || strings.ContainsRune(value, 0) {
		return "", errors.New("请选择有效的本地绝对目录")
	}
	resolved, err := filepath.EvalSymlinks(value)
	if err != nil {
		return "", fmt.Errorf("项目位置不可用：%w", err)
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", errors.New("项目位置不是可用目录")
	}
	for _, root := range forbidden {
		if root == "" {
			continue
		}
		root, err = filepath.Abs(root)
		if err != nil {
			return "", err
		}
		if actual, e := filepath.EvalSymlinks(root); e == nil {
			root = actual
		}
		rel, e := filepath.Rel(root, resolved)
		if e == nil && (rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)))) {
			return "", errors.New("作品目录不能位于工作台源码、运行数据或凭据目录内")
		}
	}
	for p := resolved; ; p = filepath.Dir(p) {
		if _, e := os.Lstat(filepath.Join(p, "项目.json")); e == nil {
			return "", errors.New("不能在已有作品目录内创建另一项目")
		} else if !errors.Is(e, fs.ErrNotExist) {
			return "", e
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	return resolved, nil
}

func Initialize(parent, child, projectID, name string, resume bool) error {
	p, err := os.OpenRoot(parent)
	if err != nil {
		return err
	}
	defer p.Close()
	created := true
	if err = p.Mkdir(child, 0o700); err != nil {
		if !resume || !errors.Is(err, fs.ErrExist) {
			return errors.New("项目目录已存在或不可写；未覆盖已有文件")
		}
		created = false
	}
	i, err := p.Lstat(child)
	if err != nil || !i.IsDir() || i.Mode()&os.ModeSymlink != 0 {
		return errors.New("项目目录身份已变化")
	}
	r, err := p.OpenRoot(child)
	if err != nil {
		return err
	}
	defer r.Close()
	const owner = ".filmos-owner"
	if !created {
		b, e := r.ReadFile(owner)
		if e != nil || string(b) != projectID {
			return errors.New("已有目录没有本次创建的归属凭证，未接管或覆盖")
		}
	}
	f, err := r.OpenFile(owner, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		_, err = f.WriteString(projectID)
		if e := f.Sync(); err == nil {
			err = e
		}
		if e := f.Close(); err == nil {
			err = e
		}
		if err != nil {
			return err
		}
	} else {
		b, e := r.ReadFile(owner)
		if !resume || e != nil || string(b) != projectID {
			return errors.New("目录不属于本次创建请求，未覆盖")
		}
	}
	for _, folder := range Folders {
		if err = r.Mkdir(folder, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
			return err
		}
		info, e := r.Lstat(folder)
		if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("标准目录被替换，初始化已停止")
		}
	}
	if _, err = r.Lstat("项目.json"); errors.Is(err, fs.ErrNotExist) {
		b, e := json.MarshalIndent(Manifest{SchemaVersion: 1, ProjectID: projectID, Name: name, Authority: "filmos-managed; edits through workbench", Files: map[string]string{}}, "", "  ")
		if e != nil {
			return e
		}
		return atomicWrite(r, "项目.json", append(b, '\n'))
	}
	_, err = readManifest(r, projectID)
	return err
}

func readManifest(r *os.Root, projectID string) (Manifest, error) {
	var m Manifest
	owner, err := r.ReadFile(".filmos-owner")
	if err != nil || string(owner) != projectID {
		return m, errors.New("项目目录标识不匹配，请重新定位；未创建替代目录")
	}
	b, err := r.ReadFile("项目.json")
	if err != nil {
		return m, err
	}
	if json.Unmarshal(b, &m) != nil || m.ProjectID != projectID || m.SchemaVersion != 1 || m.Files == nil {
		return m, errors.New("项目清单身份或版本不匹配")
	}
	return m, nil
}

func Open(path, projectID string) (*os.Root, Manifest, error) {
	var m Manifest
	canonical, resolveErr := filepath.EvalSymlinks(path)
	if resolveErr != nil || canonical != filepath.Clean(path) {
		return nil, m, errors.New("项目路径经过新的符号链接或已离线；请重新定位原目录")
	}
	i, err := os.Lstat(path)
	if err != nil || !i.IsDir() || i.Mode()&os.ModeSymlink != 0 {
		return nil, m, errors.New("项目目录离线、不可访问或已替换；请检查磁盘并重新定位")
	}
	r, err := os.OpenRoot(path)
	if err != nil {
		return nil, m, err
	}
	m, err = readManifest(r, projectID)
	if err != nil {
		r.Close()
		return nil, m, err
	}
	return r, m, nil
}

// Check detects manual edits rather than silently overwriting an independently
// edited document. os.Root prevents symlink swaps escaping the selected tree.
func Check(path, projectID string) error {
	r, m, err := Open(path, projectID)
	if err != nil {
		return err
	}
	defer r.Close()
	for file, hash := range m.Files {
		if !fs.ValidPath(file) {
			return errors.New("项目清单包含无效文件路径")
		}
		digest, err := fileHash(r, file)
		if err == nil && m.Pending != nil && m.Pending.File == file && digest == m.Pending.After {
			continue
		}
		if err != nil || digest != hash {
			return fmt.Errorf("作品文件已在外部变化：%s；未覆盖，请先处理冲突", file)
		}
	}
	return nil
}

func Sync(path, projectID, name string, files map[string][]byte) error {
	items := map[string]File{}
	for key, body := range files {
		items[key] = Bytes(body)
	}
	return SyncFiles(path, projectID, name, items)
}

// File streams owned media. Open is a trusted in-process capability, not a
// client-supplied filesystem path. Digest is verified again during copying.
type File struct {
	Digest string
	Open   func() (io.ReadCloser, error)
}

func Bytes(body []byte) File {
	return File{Digest: Hash(body), Open: func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }}
}

func LocalFile(rootPath, objectKey string, expectedSize int64) (File, error) {
	open := func() (io.ReadCloser, error) {
		r, err := os.OpenRoot(rootPath)
		if err != nil {
			return nil, err
		}
		defer r.Close()
		f, err := r.Open(objectKey)
		if err != nil {
			return nil, err
		}
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() != expectedSize {
			f.Close()
			return nil, errors.New("本地资源类型或大小不一致")
		}
		return f, nil
	}
	f, err := open()
	if err != nil {
		return File{}, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return File{}, err
	}
	return File{Digest: hex.EncodeToString(h.Sum(nil)), Open: open}, nil
}

func fileHash(r *os.Root, name string) (string, error) {
	f, err := r.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("作品文件不是普通文件")
	}
	return readerHash(f)
}

func readerHash(r io.Reader) (string, error) {
	h := sha256.New()
	_, err := io.Copy(h, r)
	return hex.EncodeToString(h.Sum(nil)), err
}

func SyncFiles(path, projectID, name string, files map[string]File) error {
	if err := Check(path, projectID); err != nil {
		return err
	}
	r, m, err := Open(path, projectID)
	if err != nil {
		return err
	}
	defer r.Close()
	if p := m.Pending; p != nil {
		if !fs.ValidPath(p.File) {
			return errors.New("未完成写入路径无效")
		}
		digest, e := fileHash(r, p.File)
		if e == nil && digest == p.After {
			m.Files[p.File] = p.After
		} else if !(e == nil && digest == p.Before) && !(errors.Is(e, fs.ErrNotExist) && p.Before == "") {
			return errors.New("未完成写入与磁盘文件不一致；未覆盖")
		}
		m.Pending = nil
		if err = saveManifest(r, m); err != nil {
			return err
		}
	}
	keys := make([]string, 0, len(files))
	for file := range files {
		keys = append(keys, file)
	}
	sort.Strings(keys)
	for _, file := range keys {
		if !fs.ValidPath(file) || strings.Count(file, "/") != 1 {
			return errors.New("作品文件路径无效")
		}
		folder := strings.Split(file, "/")[0]
		allowed := false
		for _, f := range Folders {
			allowed = allowed || folder == f
		}
		if !allowed {
			return errors.New("作品文件不属于标准目录")
		}
		hash := files[file].Digest
		if len(hash) != 64 || files[file].Open == nil {
			return errors.New("作品内容摘要无效")
		}
		if m.Files[file] == hash {
			continue
		}
		if err := r.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			return err
		}
		if _, e := r.Lstat(file); e == nil {
			if m.Files[file] == "" {
				return fmt.Errorf("目标文件不属于工作台，未覆盖：%s", file)
			}
			archive := "历史/" + m.Files[file] + filepath.Ext(file)
			if _, e = r.Lstat(archive); errors.Is(e, fs.ErrNotExist) {
				old := File{Digest: m.Files[file], Open: func() (io.ReadCloser, error) { return r.Open(file) }}
				if e = atomicCopy(r, archive, old); e != nil {
					return e
				}
			} else if digest, checkErr := fileHash(r, archive); checkErr != nil || digest != m.Files[file] {
				return errors.New("历史文件冲突，未覆盖")
			}
		} else if !errors.Is(e, fs.ErrNotExist) {
			return e
		}
		m.Pending = &PendingWrite{File: file, Before: m.Files[file], After: hash}
		if err = saveManifest(r, m); err != nil {
			return err
		}
		if err = atomicCopy(r, file, files[file]); err != nil {
			return err
		}
		m.Files[file] = hash
		m.Pending = nil
		// Persist progress per file, so a failed later file is safely retryable.
		m.Name = name
		if err = saveManifest(r, m); err != nil {
			return err
		}
	}
	m.CurrentFiles = keys
	m.Name = name
	return saveManifest(r, m)
}

func saveManifest(r *os.Root, m Manifest) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(r, "项目.json", append(b, '\n'))
}

func atomicWrite(r *os.Root, name string, body []byte) error {
	return atomicCopy(r, name, Bytes(body))
}

func atomicCopy(r *os.Root, name string, source File) error {
	// Only FilmOS-generated names reach this helper; the temporary file is
	// exclusively created and never reuses or truncates a user's existing file.
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	tmp := name + ".filmos-" + hex.EncodeToString(nonce[:])
	f, err := r.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer r.Remove(tmp)
	input, err := source.Open()
	if err == nil {
		h := sha256.New()
		_, err = io.Copy(io.MultiWriter(f, h), input)
		if e := input.Close(); err == nil {
			err = e
		}
		if err == nil && hex.EncodeToString(h.Sum(nil)) != source.Digest {
			err = errors.New("复制期间源内容发生变化")
		}
		if err == nil {
			err = f.Sync()
		}
	}
	if e := f.Close(); err == nil {
		err = e
	}
	if err != nil {
		return err
	}
	return r.Rename(tmp, name)
}
