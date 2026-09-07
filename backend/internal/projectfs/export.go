package projectfs

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sort"
)

// Export packages the current projection, not the runtime database, credentials
// or other exports. It is an evidence/content archive, not a second active project.
func Export(path, projectID string) (string, string, error) {
	if err := Check(path, projectID); err != nil {
		return "", "", err
	}
	r, m, err := Open(path, projectID)
	if err != nil {
		return "", "", err
	}
	defer r.Close()
	manifest := m
	manifest.Files = map[string]string{}
	manifest.Pending = nil
	for _, file := range m.CurrentFiles {
		manifest.Files[file] = m.Files[file]
	}
	body, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", "", err
	}
	fileName := "导出/作品-" + Hash(body)[:20] + ".zip"
	// A bounded pipe streams the ZIP, including media, without buffering it.
	stream := func() (io.ReadCloser, error) {
		reader, writer := io.Pipe()
		go func() {
			z := zip.NewWriter(writer)
			write := func(name string, source io.Reader) error {
				entry, e := z.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate})
				if e != nil {
					return e
				}
				_, e = io.Copy(entry, source)
				return e
			}
			data, _ := Bytes(append(body, '\n')).Open()
			e := write("项目.json", data)
			data.Close()
			keys := append([]string(nil), m.CurrentFiles...)
			sort.Strings(keys)
			for _, name := range keys {
				if e != nil {
					break
				}
				var input *os.File
				input, e = r.Open(name)
				if e != nil {
					break
				}
				h := sha256.New()
				e = write(name, io.TeeReader(input, h))
				if e == nil && hex.EncodeToString(h.Sum(nil)) != m.Files[name] {
					e = errors.New("导出期间作品内容已变化")
				}
				input.Close()
			}
			closeErr := z.Close()
			if e == nil {
				e = closeErr
			}
			writer.CloseWithError(e)
		}()
		return reader, nil
	}
	// Digest first, then verify identical bytes while atomically writing; a
	// changed source or export-name collision is never silently overwritten.
	input, err := stream()
	if err != nil {
		return "", "", err
	}
	digest, err := readerHash(input)
	input.Close()
	if err != nil {
		return "", "", err
	}
	if existing, e := fileHash(r, fileName); e == nil {
		if existing != digest {
			return "", "", errors.New("导出文件在外部变化，未覆盖")
		}
		return fileName, digest, nil
	} else if !errors.Is(e, os.ErrNotExist) {
		return "", "", e
	}
	if err = atomicCopy(r, fileName, File{Digest: digest, Open: stream}); err != nil {
		return "", "", err
	}
	return fileName, digest, nil
}
