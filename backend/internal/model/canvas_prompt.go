package model

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
)

var ErrCanvasPromptConflict = errors.New("canvas prompt revision conflict")

// The current text stays in CanvasProject.PayloadJSON. These records are only
// immutable history and request receipts, never a second editable prompt store.
type CanvasPromptRevision struct {
	ID             string          `json:"id" gorm:"primaryKey;size:36"`
	UserID         string          `json:"-" gorm:"index;size:36"`
	CanvasID       string          `json:"canvasId" gorm:"size:100;uniqueIndex:idx_canvas_prompt_revision,priority:1"`
	NodeID         string          `json:"nodeId" gorm:"size:100;uniqueIndex:idx_canvas_prompt_revision,priority:2"`
	RowID          string          `json:"rowId" gorm:"size:100;uniqueIndex:idx_canvas_prompt_revision,priority:3"`
	Kind           string          `json:"kind" gorm:"size:10;uniqueIndex:idx_canvas_prompt_revision,priority:4"`
	Revision       int64           `json:"revision" gorm:"uniqueIndex:idx_canvas_prompt_revision,priority:5"`
	Prompt         string          `json:"prompt" gorm:"type:text"`
	ContentHash    string          `json:"contentHash" gorm:"size:64"`
	DependencyHash string          `json:"dependencyHash" gorm:"size:64"`
	Dependencies   json.RawMessage `json:"dependencies" gorm:"serializer:json;type:text"`
	RequestID      string          `json:"requestId" gorm:"size:100"`
	CreatedAt      time.Time       `json:"createdAt"`
}

type CanvasPromptReceipt struct {
	ID          string               `json:"id" gorm:"primaryKey;size:36"`
	UserID      string               `json:"-" gorm:"index;size:36"`
	CanvasID    string               `json:"canvasId" gorm:"size:100;uniqueIndex:idx_canvas_prompt_request,priority:1"`
	RequestID   string               `json:"requestId" gorm:"size:100;uniqueIndex:idx_canvas_prompt_request,priority:2"`
	RequestHash string               `json:"requestHash" gorm:"size:64"`
	Snapshot    CanvasPromptRevision `json:"snapshot" gorm:"serializer:json;type:text"`
	CreatedAt   time.Time            `json:"createdAt"`
}

type CanvasPromptState struct {
	Revision       int64  `json:"revision"`
	ContentHash    string `json:"contentHash"`
	DependencyHash string `json:"dependencyHash"`
}

// Raw-message objects preserve unrelated fields and number precision when a
// single prompt is patched. Duplicate node/row identities fail closed.
type CanvasPromptDocument struct {
	Root  map[string]json.RawMessage
	Nodes []map[string]json.RawMessage
}

func ParseCanvasPromptDocument(raw []byte) (*CanvasPromptDocument, error) {
	var root map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(&root); err != nil || root == nil {
		return nil, errors.New("invalid canvas document")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, errors.New("multiple canvas documents")
	}
	var nodes []map[string]json.RawMessage
	if rawNodes, ok := root["nodes"]; ok {
		if err := json.Unmarshal(rawNodes, &nodes); err != nil {
			return nil, err
		}
	}
	seen := map[string]bool{}
	for _, node := range nodes {
		id := CanvasJSONText(node, "id")
		if id == "" || seen[id] {
			return nil, errors.New("canvas node identity missing or duplicated")
		}
		seen[id] = true
	}
	return &CanvasPromptDocument{Root: root, Nodes: nodes}, nil
}

type CanvasPromptTarget struct {
	Document   *CanvasPromptDocument
	Node       map[string]json.RawMessage
	Metadata   map[string]json.RawMessage
	Storyboard map[string]json.RawMessage
	Rows       []map[string]json.RawMessage
	Row        map[string]json.RawMessage
}

func (d *CanvasPromptDocument) Target(nodeID, rowID string) (*CanvasPromptTarget, error) {
	var node map[string]json.RawMessage
	for _, item := range d.Nodes {
		if CanvasJSONText(item, "id") == nodeID {
			node = item
		}
	}
	if node == nil || CanvasJSONText(node, "type") != "script" {
		return nil, errors.New("script node not found")
	}
	var metadata, storyboard map[string]json.RawMessage
	if json.Unmarshal(node["metadata"], &metadata) != nil || metadata == nil || json.Unmarshal(metadata["storyboard"], &storyboard) != nil || storyboard == nil {
		return nil, errors.New("storyboard not found")
	}
	var rows []map[string]json.RawMessage
	if json.Unmarshal(storyboard["rows"], &rows) != nil {
		return nil, errors.New("storyboard rows invalid")
	}
	seen := map[string]bool{}
	var row map[string]json.RawMessage
	for _, item := range rows {
		id := CanvasJSONText(item, "id")
		if id == "" || seen[id] {
			return nil, errors.New("storyboard row identity missing or duplicated")
		}
		seen[id] = true
		if id == rowID {
			row = item
		}
	}
	if row == nil {
		return nil, errors.New("storyboard row not found")
	}
	return &CanvasPromptTarget{Document: d, Node: node, Metadata: metadata, Storyboard: storyboard, Rows: rows, Row: row}, nil
}

func CanvasJSONText(object map[string]json.RawMessage, key string) string {
	var value string
	_ = json.Unmarshal(object[key], &value)
	return value
}

func CanvasPromptField(kind string) (string, error) {
	switch kind {
	case "image":
		return "imageGenerationPrompt", nil
	case "video":
		return "videoMotionPrompt", nil
	}
	return "", errors.New("prompt kind must be image or video")
}

func (t *CanvasPromptTarget) State(kind string) (CanvasPromptState, bool, error) {
	var states map[string]CanvasPromptState
	if raw, ok := t.Row["promptDrafts"]; ok {
		if err := json.Unmarshal(raw, &states); err != nil {
			return CanvasPromptState{}, false, err
		}
	}
	state, ok := states[kind]
	_, contentErr := hex.DecodeString(state.ContentHash)
	_, dependencyErr := hex.DecodeString(state.DependencyHash)
	if ok && (state.Revision < 1 || len(state.ContentHash) != 64 || len(state.DependencyHash) != 64 || contentErr != nil || dependencyErr != nil) {
		return state, true, errors.New("invalid prompt state")
	}
	return state, ok, nil
}

func (t *CanvasPromptTarget) SetPrompt(kind, prompt string, state CanvasPromptState) ([]byte, error) {
	field, err := CanvasPromptField(kind)
	if err != nil {
		return nil, err
	}
	var states map[string]CanvasPromptState
	if raw, ok := t.Row["promptDrafts"]; ok {
		if err := json.Unmarshal(raw, &states); err != nil {
			return nil, err
		}
	}
	if states == nil {
		states = map[string]CanvasPromptState{}
	}
	states[kind] = state
	t.Row[field], _ = json.Marshal(prompt)
	t.Row["promptDrafts"], _ = json.Marshal(states)
	// A literal edit invalidates only the matching generated-template variables.
	if kind == "image" {
		delete(t.Row, "imagePromptTemplateVariables")
	} else {
		delete(t.Row, "videoPromptTemplateVariables")
	}
	t.Storyboard["rows"], err = json.Marshal(t.Rows)
	if err != nil {
		return nil, err
	}
	t.Metadata["storyboard"], err = json.Marshal(t.Storyboard)
	if err != nil {
		return nil, err
	}
	t.Node["metadata"], err = json.Marshal(t.Metadata)
	if err != nil {
		return nil, err
	}
	t.Document.Root["nodes"], err = json.Marshal(t.Document.Nodes)
	if err != nil {
		return nil, err
	}
	// Native node/row deletion may proceed only from a snapshot that observed
	// the latest prompt write. A stale canvas cannot silently delete that write.
	identity, _ := json.Marshal([]any{CanvasJSONText(t.Node, "id"), CanvasJSONText(t.Row, "id"), kind, state})
	token := sha256.Sum256(identity)
	t.Document.Root["promptWriteToken"], _ = json.Marshal(hex.EncodeToString(token[:]))
	return json.Marshal(t.Document.Root)
}

// Whole-canvas writers may move/layout a versioned prompt, but cannot forge or
// overwrite it. Native row/node deletion requires the last prompt-write token;
// erasing only version metadata on a surviving row is never a deletion.
func ValidateCanvasPromptPreservation(before, after []byte) error {
	old, err := ParseCanvasPromptDocument(before)
	if err != nil {
		return err
	}
	next, err := ParseCanvasPromptDocument(after)
	if err != nil {
		return err
	}
	oldSlots, err := canvasPromptSlots(old)
	if err != nil {
		return err
	}
	nextSlots, err := canvasPromptSlots(next)
	if err != nil {
		return err
	}
	if len(nextSlots) > len(oldSlots) {
		return ErrCanvasPromptConflict
	}
	if len(oldSlots) > 0 && CanvasJSONText(old.Root, "projectId") != CanvasJSONText(next.Root, "projectId") {
		return ErrCanvasPromptConflict
	}
	for key, value := range oldSlots {
		if _, present := nextSlots[key]; !present {
			token := CanvasJSONText(old.Root, "promptWriteToken")
			if token == "" || CanvasJSONText(next.Root, "promptWriteToken") != token {
				return ErrCanvasPromptConflict
			}
			for _, node := range next.Nodes {
				if CanvasJSONText(node, "id") != key[0] {
					continue
				}
				var metadata struct {
					Storyboard struct {
						Rows []map[string]json.RawMessage `json:"rows"`
					} `json:"storyboard"`
				}
				if raw, ok := node["metadata"]; ok && json.Unmarshal(raw, &metadata) != nil {
					return ErrCanvasPromptConflict
				}
				for _, row := range metadata.Storyboard.Rows {
					if CanvasJSONText(row, "id") == key[1] {
						return ErrCanvasPromptConflict
					}
				}
			}
			continue
		}
		if nextSlots[key] != value {
			return fmt.Errorf("%w: %s", ErrCanvasPromptConflict, key)
		}
	}
	for key := range nextSlots {
		if _, ok := oldSlots[key]; !ok {
			return ErrCanvasPromptConflict
		}
	}
	return nil
}

func ValidateCanvasPromptProjectAssignment(raw []byte, projectID string) error {
	doc, err := ParseCanvasPromptDocument(raw)
	if err != nil {
		return err
	}
	slots, err := canvasPromptSlots(doc)
	if err != nil {
		return err
	}
	if len(slots) > 0 && CanvasJSONText(doc.Root, "projectId") != projectID {
		return ErrCanvasPromptConflict
	}
	return nil
}

func canvasPromptSlots(d *CanvasPromptDocument) (map[[3]string]string, error) {
	result := map[[3]string]string{}
	for _, node := range d.Nodes {
		var metadata struct {
			Storyboard struct {
				Rows []map[string]json.RawMessage `json:"rows"`
			} `json:"storyboard"`
		}
		if raw, ok := node["metadata"]; ok {
			if err := json.Unmarshal(raw, &metadata); err != nil {
				return nil, err
			}
		}
		for _, row := range metadata.Storyboard.Rows {
			if _, ok := row["promptDrafts"]; !ok {
				continue
			}
			target, err := d.Target(CanvasJSONText(node, "id"), CanvasJSONText(row, "id"))
			if err != nil {
				return nil, err
			}
			var rawStates map[string]json.RawMessage
			if err := json.Unmarshal(row["promptDrafts"], &rawStates); err != nil {
				return nil, err
			}
			for kind := range rawStates {
				field, err := CanvasPromptField(kind)
				if err != nil {
					return nil, err
				}
				state, _, err := target.State(kind)
				if err != nil {
					return nil, err
				}
				var source struct {
					ID string `json:"id"`
				}
				if err := json.Unmarshal(row["projectShotSource"], &source); err != nil {
					return nil, err
				}
				body, _ := json.Marshal(struct {
					State  CanvasPromptState
					Text   string
					ShotID string
					UnitID string
				}{state, CanvasJSONText(row, field), source.ID, CanvasJSONText(target.Metadata, "chapterId")})
				key := [3]string{CanvasJSONText(node, "id"), CanvasJSONText(row, "id"), kind}
				if _, ok := result[key]; ok {
					return nil, errors.New("duplicate prompt target")
				}
				result[key] = string(body)
			}
		}
	}
	return result, nil
}
