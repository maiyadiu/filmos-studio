package model

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

const promptCanvas = `{"id":"canvas","projectId":"project","preservedNumber":9007199254740993,"nodes":[{"id":"node","type":"script","position":{"x":12,"y":34},"metadata":{"chapterId":"chapter","storyboard":{"visibleColumns":["dialogue"],"rows":[{"id":"project-shot:shot","projectShotSource":{"id":"shot","revision":1},"imageGenerationPrompt":"旧图词","videoMotionPrompt":"旧视频词","imagePromptTemplateVariables":{"subject":"旧"},"videoPromptTemplateVariables":{"action":"保留"},"camera":"固定","assetBindings":[{"nodeId":"image","role":"character"}]},{"id":"unrelated","camera":"保留","imageGenerationPrompt":"不改"}]}}},{"id":"image","type":"image","metadata":{"storageKey":"resource:owned"}}],"connections":[{"id":"keep","fromNodeId":"node","toNodeId":"image"}]}`

func patchedPrompt(t *testing.T) []byte {
	t.Helper()
	doc, err := ParseCanvasPromptDocument([]byte(promptCanvas))
	if err != nil {
		t.Fatal(err)
	}
	target, err := doc.Target("node", "project-shot:shot")
	if err != nil {
		t.Fatal(err)
	}
	result, err := target.SetPrompt("image", "新图词", CanvasPromptState{Revision: 1, ContentHash: strings.Repeat("a", 64), DependencyHash: strings.Repeat("b", 64)})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestCanvasPromptPatchPreservesUnrelatedFieldsAndPrecision(t *testing.T) {
	result := patchedPrompt(t)
	if !strings.Contains(string(result), `9007199254740993`) {
		t.Fatal("number precision lost")
	}
	doc, _ := ParseCanvasPromptDocument(result)
	target, _ := doc.Target("node", "project-shot:shot")
	for key, want := range map[string]string{"imageGenerationPrompt": "新图词", "videoMotionPrompt": "旧视频词", "camera": "固定"} {
		if got := CanvasJSONText(target.Row, key); got != want {
			t.Fatalf("%s=%s", key, got)
		}
	}
	if _, ok := target.Row["imagePromptTemplateVariables"]; ok {
		t.Fatal("edited template variables retained")
	}
	if _, ok := target.Row["videoPromptTemplateVariables"]; !ok {
		t.Fatal("unrelated template removed")
	}
	if string(target.Row["assetBindings"]) != `[{"nodeId":"image","role":"character"}]` {
		t.Fatal("asset bindings changed")
	}
	other, _ := doc.Target("node", "unrelated")
	if CanvasJSONText(other.Row, "imageGenerationPrompt") != "不改" {
		t.Fatal("other row changed")
	}
	state, ok, err := target.State("image")
	if err != nil || !ok || state.Revision != 1 {
		t.Fatalf("state: %+v %v", state, err)
	}
}

func TestCanvasPromptWholeCanvasPreservation(t *testing.T) {
	before := patchedPrompt(t)
	if err := ValidateCanvasPromptPreservation(before, before); err != nil {
		t.Fatal(err)
	}
	for _, change := range []struct{ from, to string }{
		{`"新图词"`, `"陈旧客户端覆盖"`},
		{`"promptDrafts":{"image":{"revision":1`, `"promptDrafts":{"image":{"revision":2`},
		{`"promptDrafts"`, `"deletedPromptState"`},
		{`"projectId":"project"`, `"projectId":"elsewhere"`},
		{`"id":"shot"`, `"id":"other-shot"`},
	} {
		next := []byte(strings.Replace(string(before), change.from, change.to, 1))
		if err := ValidateCanvasPromptPreservation(before, next); !errors.Is(err, ErrCanvasPromptConflict) {
			t.Fatalf("expected conflict for %s: %v", change.from, err)
		}
	}
	if err := ValidateCanvasPromptPreservation([]byte(promptCanvas), before); !errors.Is(err, ErrCanvasPromptConflict) {
		t.Fatal("forged managed prompt accepted")
	}
	// Layout and business source revisions can change, leaving the saved prompt
	// intact for an explicit stale-dependency check rather than erasing history.
	next := strings.Replace(string(before), `"x":12`, `"x":42`, 1)
	var root map[string]json.RawMessage
	_ = json.Unmarshal([]byte(next), &root)
	doc, _ := ParseCanvasPromptDocument([]byte(next))
	target, _ := doc.Target("node", "project-shot:shot")
	target.Row["projectShotSource"] = json.RawMessage(`{"id":"shot","revision":2}`)
	state, _, _ := target.State("image")
	updated, _ := target.SetPrompt("image", "新图词", state)
	if err := ValidateCanvasPromptPreservation(before, updated); err != nil {
		t.Fatal(err)
	}
}

func TestCanvasPromptNativeDeletionRequiresCurrentWriteToken(t *testing.T) {
	before := patchedPrompt(t)
	doc, _ := ParseCanvasPromptDocument(before)
	doc.Root["nodes"], _ = json.Marshal(doc.Nodes[1:])
	after, _ := json.Marshal(doc.Root)
	if err := ValidateCanvasPromptPreservation(before, after); err != nil {
		t.Fatalf("current native delete blocked: %v", err)
	}
	if err := ValidateCanvasPromptPreservation(after, before); !errors.Is(err, ErrCanvasPromptConflict) {
		t.Fatal("stale canvas resurrected deleted managed row")
	}
	doc.Root["promptWriteToken"] = json.RawMessage(`"stale"`)
	stale, _ := json.Marshal(doc.Root)
	if err := ValidateCanvasPromptPreservation(before, stale); !errors.Is(err, ErrCanvasPromptConflict) {
		t.Fatal("stale deletion accepted")
	}
	if err := ValidateCanvasPromptProjectAssignment(before, "elsewhere"); !errors.Is(err, ErrCanvasPromptConflict) {
		t.Fatal("managed canvas reassigned")
	}
}

func TestCanvasPromptTargetRejectsAmbiguityAndInvalidState(t *testing.T) {
	if _, err := ParseCanvasPromptDocument([]byte(promptCanvas + `{}`)); err == nil {
		t.Fatal("multiple documents accepted")
	}
	if _, err := ParseCanvasPromptDocument([]byte(strings.Replace(promptCanvas, `"id":"image","type"`, `"id":"node","type"`, 1))); err == nil {
		t.Fatal("duplicate node accepted")
	}
	doc, _ := ParseCanvasPromptDocument([]byte(strings.Replace(promptCanvas, `"id":"unrelated"`, `"id":"project-shot:shot"`, 1)))
	if _, err := doc.Target("node", "project-shot:shot"); err == nil {
		t.Fatal("duplicate row accepted")
	}
	doc, _ = ParseCanvasPromptDocument([]byte(promptCanvas))
	target, _ := doc.Target("node", "project-shot:shot")
	if _, err := target.SetPrompt("unknown", "text", CanvasPromptState{}); err == nil {
		t.Fatal("invalid kind accepted")
	}
	target.Row["promptDrafts"] = json.RawMessage(`{"image":{"revision":-1}}`)
	if _, _, err := target.State("image"); err == nil {
		t.Fatal("invalid version accepted")
	}
	if _, err := doc.Target("node", "missing"); err == nil {
		t.Fatal("missing row accepted")
	}
}
