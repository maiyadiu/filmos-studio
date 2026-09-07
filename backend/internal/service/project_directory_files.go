package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/projectfs"
)

// The database remains the only editable authority. Every successful managed
// write materializes project-owned documents; files are not silently imported.
func (s *Service) projectDirectoryFiles(userID, projectID string) (map[string]projectfs.File, string, error) {
	snapshot, err := s.repo.ProjectDirectorySnapshot(userID, projectID)
	if err != nil {
		return nil, "", err
	}
	files := map[string]projectfs.File{}
	put := func(path string, value any) error {
		b, e := json.Marshal(value)
		if e != nil {
			return e
		}
		var tree any
		decoder := json.NewDecoder(bytes.NewReader(b))
		decoder.UseNumber()
		if e = decoder.Decode(&tree); e != nil {
			return e
		}
		stripDirectorySecrets(tree)
		b, e = json.MarshalIndent(tree, "", "  ")
		if e != nil {
			return e
		}
		files[path] = projectfs.Bytes(append(b, '\n'))
		return nil
	}
	if err = put("设定/项目.json", snapshot.Project); err != nil {
		return nil, "", err
	}
	for path, value := range map[string]any{"素材/分类.json": snapshot.Folders, "素材/项目关联.json": snapshot.AssetLinks, "设定/声音绑定.json": snapshot.Voices, "设定/工作流.json": snapshot.Workflows, "生成/工作流步骤.json": snapshot.Steps, "分镜/素材关联.json": snapshot.References, "分镜/画布关联.json": snapshot.CanvasLinks, "设定/候选.json": snapshot.Candidates} {
		if err = put(path, value); err != nil {
			return nil, "", err
		}
	}
	for _, unit := range snapshot.Units {
		base := "剧本/" + safeDirectoryID(unit.ID)
		if err = put(base+".json", unit); err != nil {
			return nil, "", err
		}
		// Keep exact original bytes; the workbench supplies the readable view.
		ext := ".md"
		if strings.HasPrefix(strings.TrimSpace(unit.SourceText), "<") {
			ext = ".html"
		}
		files[base+ext] = projectfs.Bytes([]byte(unit.SourceText))
	}
	for _, row := range snapshot.Scripts {
		if err = put("历史/剧本-"+safeDirectoryID(row.UnitID)+fmt.Sprintf("-v%d.json", row.Revision), row); err != nil {
			return nil, "", err
		}
	}
	for _, row := range snapshot.ScriptBatches {
		if err = put("历史/建章-"+safeDirectoryID(row.ID)+".json", row); err != nil {
			return nil, "", err
		}
	}
	for _, row := range snapshot.Shots {
		if err = put("分镜/"+safeDirectoryID(row.ID)+".json", row); err != nil {
			return nil, "", err
		}
	}
	for _, row := range snapshot.ShotHistory {
		if err = put("历史/分镜-"+safeDirectoryID(row.ID)+".json", row); err != nil {
			return nil, "", err
		}
	}
	resourceIDs := map[string]bool{}
	for _, step := range snapshot.Steps {
		var output any
		if json.Unmarshal([]byte(step.OutputJSON), &output) == nil {
			collectDirectoryResources(output, resourceIDs)
		}
	}
	for _, canvas := range snapshot.Canvases {
		var doc any
		decoder := json.NewDecoder(strings.NewReader(canvas.PayloadJSON))
		decoder.UseNumber()
		if decoder.Decode(&doc) != nil {
			return nil, "", fmt.Errorf("画布%s内容无效", canvas.ID)
		}
		collectDirectoryResources(doc, resourceIDs)
		if err = put("分镜/画布-"+safeDirectoryID(canvas.ID)+".json", doc); err != nil {
			return nil, "", err
		}
	}
	latestPrompts := map[string]int64{}
	for _, prompt := range snapshot.Prompts {
		if err = put("历史/提示词-"+safeDirectoryID(prompt.ID)+".json", prompt); err != nil {
			return nil, "", err
		}
		key := safeDirectoryID(prompt.CanvasID + ":" + prompt.NodeID + ":" + prompt.RowID + ":" + prompt.Kind)
		if revision, ok := latestPrompts[key]; ok && revision >= prompt.Revision {
			continue
		}
		latestPrompts[key] = prompt.Revision
		files["提示词/"+key+".md"] = projectfs.Bytes([]byte(prompt.Prompt))
		if err = put("提示词/"+key+".json", prompt); err != nil {
			return nil, "", err
		}
	}
	for _, asset := range snapshot.Assets {
		if err = put("设定/素材-"+safeDirectoryID(asset.ID)+".json", asset); err != nil {
			return nil, "", err
		}
		var doc any
		if json.Unmarshal([]byte(asset.PayloadJSON), &doc) == nil {
			collectDirectoryResources(doc, resourceIDs)
		}
	}
	for _, version := range snapshot.Versions {
		if err = put("设定/版本-"+safeDirectoryID(version.ID)+".json", version); err != nil {
			return nil, "", err
		}
	}
	for _, rep := range snapshot.Representations {
		if rep.ResourceID != "" {
			resourceIDs[rep.ResourceID] = true
		}
		if err = put("素材/视图-"+safeDirectoryID(rep.ID)+".json", rep); err != nil {
			return nil, "", err
		}
	}
	for id := range resourceIDs {
		resource, e := s.repo.ResourceForUser(userID, id)
		if e != nil {
			return nil, "", fmt.Errorf("项目资源不可读取：%s", id)
		}
		entry := map[string]any{"resourceId": id, "kind": resource.Kind, "mimeType": resource.MimeType, "size": resource.Size, "provider": resource.Provider, "external": resource.Provider != "local"}
		if resource.Provider == "local" {
			if resource.Status != model.ResourceStatusReady {
				return nil, "", fmt.Errorf("项目资源尚未保存：%s", id)
			}
			media, e := projectfs.LocalFile(filepath.Join(s.dataDir, "resources"), filepath.FromSlash(resource.ObjectKey), resource.Size)
			if e != nil {
				return nil, "", e
			}
			ext := filepath.Ext(resource.ObjectKey)
			if len(ext) > 10 || strings.ContainsAny(ext, "/\\") {
				ext = ".bin"
			}
			path := "素材/文件-" + safeDirectoryID(id) + ext
			files[path] = media
			entry["path"] = path
			entry["sha256"] = media.Digest
		}
		// Remote objects stay explicit external references; no account settings,
		// signed URLs, credentials or unrequested upstream downloads are copied.
		if err = put("素材/索引-"+safeDirectoryID(id)+".json", entry); err != nil {
			return nil, "", err
		}
	}
	return files, snapshot.Project.Name, nil
}

func safeDirectoryID(id string) string {
	if id != "" && len(id) <= 100 && !strings.ContainsAny(id, "/\\:.\x00\r\n") {
		return id
	}
	return projectfs.Hash([]byte(id))[:32]
}

func collectDirectoryResources(value any, ids map[string]bool) {
	switch v := value.(type) {
	case map[string]any:
		for k, x := range v {
			if k == "storageKey" {
				if key, ok := x.(string); ok && strings.HasPrefix(key, "resource:") && len(key) > len("resource:") {
					ids[strings.TrimPrefix(key, "resource:")] = true
				}
			}
			if k == "resourceId" {
				if id, ok := x.(string); ok && id != "" {
					ids[id] = true
				}
			}
			collectDirectoryResources(x, ids)
		}
	case []any:
		for _, x := range v {
			collectDirectoryResources(x, ids)
		}
	}
}

func stripDirectorySecrets(value any) {
	switch v := value.(type) {
	case map[string]any:
		for k, x := range v {
			n := strings.ToLower(strings.ReplaceAll(k, "_", ""))
			if n == "apikey" || n == "authorization" || n == "cookie" || n == "accesstoken" || n == "refreshtoken" || n == "accesskeysecret" || n == "password" {
				delete(v, k)
				continue
			}
			if text, ok := x.(string); ok && (strings.HasSuffix(n, "url") || strings.HasSuffix(n, "uri")) {
				if parsed, err := url.Parse(text); err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") {
					parsed.User = nil
					parsed.RawQuery = ""
					parsed.Fragment = ""
					v[k] = parsed.String()
				}
			}
			if strings.HasSuffix(n, "json") {
				if raw, ok := x.(string); ok {
					var nested any
					if json.Unmarshal([]byte(raw), &nested) == nil {
						stripDirectorySecrets(nested)
						b, _ := json.Marshal(nested)
						v[k] = string(b)
						continue
					}
				}
			}
			stripDirectorySecrets(x)
		}
	case []any:
		for _, x := range v {
			stripDirectorySecrets(x)
		}
	}
}
