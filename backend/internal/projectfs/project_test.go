package projectfs

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestProjectFilesStreamMediaAndExportCurrentBytes(t *testing.T) {
	p := fixture(t)
	if err := Sync(p, "project-123", "测试", map[string][]byte{"素材/多余一层/文件.png": []byte("x")}); err == nil {
		t.Fatal("nested layout accepted")
	}
	source := t.TempDir()
	media := bytes.Repeat([]byte("media fixture"), 100000)
	if err := os.WriteFile(filepath.Join(source, "clip.mp4"), media, 0o600); err != nil {
		t.Fatal(err)
	}
	item, err := LocalFile(source, "clip.mp4", int64(len(media)))
	if err != nil {
		t.Fatal(err)
	}
	items := map[string]File{"剧本/x.md": Bytes([]byte("逐字保留")), "素材/文件-clip.mp4": item}
	if err = SyncFiles(p, "project-123", "测试", items); err != nil {
		t.Fatal(err)
	}
	name, digest, err := Export(p, "project-123")
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.OpenReader(filepath.Join(p, name))
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	seen := map[string]bool{}
	for _, file := range archive.File {
		seen[file.Name] = true
		if file.Name == "素材/文件-clip.mp4" {
			r, e := file.Open()
			if e != nil {
				t.Fatal(e)
			}
			got, e := io.ReadAll(r)
			r.Close()
			if e != nil || !bytes.Equal(got, media) {
				t.Fatal("media export mismatch", e)
			}
		}
	}
	if len(seen) != 3 || !seen["项目.json"] || !seen["剧本/x.md"] || !seen["素材/文件-clip.mp4"] {
		t.Fatal(seen)
	}
	name2, digest2, err := Export(p, "project-123")
	if err != nil || name != name2 || digest != digest2 {
		t.Fatal("export replay mismatch", err)
	}
	if err = os.WriteFile(filepath.Join(source, "clip.mp4"), bytes.Repeat([]byte("x"), len(media)), 0o600); err != nil {
		t.Fatal(err)
	}
	items["素材/文件-new.mp4"] = item
	if err = SyncFiles(p, "project-123", "测试", items); err == nil {
		t.Fatal("changed source accepted")
	}
	if _, err = os.Stat(filepath.Join(p, "素材/文件-new.mp4")); !os.IsNotExist(err) {
		t.Fatal("changed source landed")
	}
}

func fixture(t *testing.T) string {
	t.Helper()
	p := t.TempDir()
	p, _ = filepath.EvalSymlinks(p)
	if err := Initialize(p, "测试作品", "project-123", "测试作品", false); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(p, "测试作品")
}

func TestProjectFilesPreserveHistoryAndRejectExternalChanges(t *testing.T) {
	p := fixture(t)
	file := "剧本/第一章.md"
	for _, text := range []string{"原始正文", "修订正文"} {
		if err := Sync(p, "project-123", "测试作品", map[string][]byte{file: []byte(text)}); err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(filepath.Join(p, "历史", Hash([]byte("原始正文"))+".md"))
	if err != nil || string(b) != "原始正文" {
		t.Fatalf("missing history: %v", err)
	}
	if err := os.WriteFile(filepath.Join(p, file), []byte("用户手工修改"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Sync(p, "project-123", "测试作品", map[string][]byte{file: []byte("不能覆盖")}); err == nil {
		t.Fatal("external edit accepted")
	}
	b, _ = os.ReadFile(filepath.Join(p, file))
	if string(b) != "用户手工修改" {
		t.Fatal("external edit overwritten")
	}
}

func TestProjectFilesRejectSymlinkEscapeAndIdentityChange(t *testing.T) {
	p := fixture(t)
	outside := t.TempDir()
	if err := os.Remove(filepath.Join(p, "剧本")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(p, "剧本")); err != nil {
		t.Fatal(err)
	}
	if err := Sync(p, "project-123", "x", map[string][]byte{"剧本/x.md": []byte("x")}); err == nil {
		t.Fatal("escaped root")
	}
	entries, _ := os.ReadDir(outside)
	if len(entries) != 0 {
		t.Fatal("wrote outside root")
	}
	if _, _, err := Open(p, "another-project"); err == nil {
		t.Fatal("wrong identity accepted")
	}
}

func TestProjectFilesRecoverInterruptedManifestCommit(t *testing.T) {
	for _, landed := range []bool{false, true} {
		t.Run(map[bool]string{true: "file-written", false: "file-not-written"}[landed], func(t *testing.T) {
			p := fixture(t)
			f := "剧本/x.md"
			if err := Sync(p, "project-123", "x", map[string][]byte{f: []byte("old")}); err != nil {
				t.Fatal(err)
			}
			r, m, err := Open(p, "project-123")
			if err != nil {
				t.Fatal(err)
			}
			m.Pending = &PendingWrite{File: f, Before: Hash([]byte("old")), After: Hash([]byte("new"))}
			if err = saveManifest(r, m); err != nil {
				t.Fatal(err)
			}
			if landed {
				if err = atomicWrite(r, f, []byte("new")); err != nil {
					t.Fatal(err)
				}
			}
			r.Close()
			if err = Sync(p, "project-123", "x", map[string][]byte{f: []byte("new")}); err != nil {
				t.Fatal(err)
			}
			b, _ := os.ReadFile(filepath.Join(p, "项目.json"))
			m = Manifest{}
			if json.Unmarshal(b, &m) != nil || m.Pending != nil || m.Files[f] != Hash([]byte("new")) {
				t.Fatal("recovery incomplete")
			}
		})
	}
}

func TestProjectParentAndInitializationBoundaries(t *testing.T) {
	p := t.TempDir()
	child, err := ChildName("雨 夜", "abcdefgh123")
	if err != nil || child != "雨 夜-abcdefgh" {
		t.Fatal(child, err)
	}
	for _, name := range []string{"../x", "a/b", ".hidden", "x\\y", "x\n"} {
		if _, err = ChildName(name, "abcdefgh"); err == nil && name != "x\n" {
			t.Fatal(name)
		}
	}
	if _, err = ValidateParent(p, []string{p}); err == nil {
		t.Fatal("source root allowed")
	}
	if err = Initialize(p, child, "abcdefgh123", "雨 夜", false); err != nil {
		t.Fatal(err)
	}
	if err = Initialize(p, child, "different", "x", false); err == nil {
		t.Fatal("existing overwritten")
	}
	if err = Initialize(p, child, "abcdefgh123", "雨 夜", true); err != nil {
		t.Fatal(err)
	}
	if _, err = ValidateParent(filepath.Join(p, child, "剧本"), nil); err == nil {
		t.Fatal("nested project accepted")
	}
	if err = Initialize(p, child, "different", "x", true); err == nil {
		t.Fatal("wrong request resumed")
	}
}
