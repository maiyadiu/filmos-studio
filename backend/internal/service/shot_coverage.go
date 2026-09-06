package service

import (
	"infinite-canvas/backend/internal/model"
	"sort"
	"strings"
)

type ShotSourceCoverage struct {
	CoveredParagraphIDs []string `json:"coveredParagraphIds"`
	MissingParagraphIDs []string `json:"missingParagraphIds"`
	DialogueMatches     bool     `json:"dialogueMatches"`
	ChapterComplete     bool     `json:"chapterComplete"`
}

// Quotes prove traceable coverage, not semantic directing quality. Speech must
// preserve exact text/speaker/order, including delivery split across adjacent shots.
func shotSourceCoverage(paragraphs []ScriptParagraph, shots []model.Shot, scope map[string]bool) ShotSourceCoverage {
	result := ShotSourceCoverage{CoveredParagraphIDs: []string{}, MissingParagraphIDs: []string{}, DialogueMatches: true}
	byID := map[string]string{}
	wantedDialogue := []model.ShotDialogue{}
	for _, p := range paragraphs {
		byID[p.ID] = p.Text
		if scope != nil && !scope[p.ID] {
			continue
		}
		if p.Dialogue != nil {
			wantedDialogue = append(wantedDialogue, *p.Dialogue)
		}
	}
	type span struct{ start, end int }
	spans := map[string][]span{}
	actualDialogue := []model.ShotDialogue{}
	ordered := append([]model.Shot{}, shots...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Position < ordered[j].Position })
	for _, shot := range ordered {
		for _, ref := range shot.Content.SourceReferences {
			if ref.Quote == "" || strings.Count(byID[ref.ParagraphID], ref.Quote) != 1 {
				continue
			}
			start := strings.Index(byID[ref.ParagraphID], ref.Quote)
			spans[ref.ParagraphID] = append(spans[ref.ParagraphID], span{start, start + len(ref.Quote)})
		}
		for _, line := range shot.Content.Dialogue {
			if scope != nil && !scope[line.ParagraphID] {
				continue
			}
			n := len(actualDialogue)
			if n > 0 && actualDialogue[n-1].ParagraphID == line.ParagraphID && actualDialogue[n-1].Speaker == line.Speaker {
				actualDialogue[n-1].Text += line.Text
			} else {
				actualDialogue = append(actualDialogue, line)
			}
		}
	}
	for _, p := range paragraphs {
		if scope != nil && !scope[p.ID] {
			continue
		}
		parts := spans[p.ID]
		sort.Slice(parts, func(i, j int) bool { return parts[i].start < parts[j].start })
		end := 0
		for _, part := range parts {
			if part.start > end {
				break
			}
			if part.end > end {
				end = part.end
			}
		}
		if end == len(p.Text) {
			result.CoveredParagraphIDs = append(result.CoveredParagraphIDs, p.ID)
		} else {
			result.MissingParagraphIDs = append(result.MissingParagraphIDs, p.ID)
		}
	}
	if len(wantedDialogue) != len(actualDialogue) {
		result.DialogueMatches = false
	} else {
		for i := range wantedDialogue {
			if wantedDialogue[i] != actualDialogue[i] {
				result.DialogueMatches = false
				break
			}
		}
	}
	result.ChapterComplete = len(result.CoveredParagraphIDs) == len(paragraphs) && result.DialogueMatches && len(paragraphs) > 0
	return result
}

func validateShotSourceScope(paragraphs []ScriptParagraph, current []model.Shot, writes []model.Shot, sourceRevision int64, sourceHash string, requested []string) error {
	if len(requested) == 0 || len(requested) > len(paragraphs) {
		return BadAuthRequest("需要明确本次sourceParagraphIds范围；全章任务应包含读取到的全部段落")
	}
	known := map[string]bool{}
	for _, p := range paragraphs {
		known[p.ID] = true
	}
	scope := map[string]bool{}
	for _, id := range requested {
		if !known[id] || scope[id] {
			return BadAuthRequest("来源范围含未知或重复段落ID")
		}
		scope[id] = true
	}
	byID := map[string]model.Shot{}
	for _, shot := range current {
		if shot.SourceRevision == sourceRevision && shot.SourceHash == sourceHash {
			byID[shot.ID] = shot
		}
	}
	for _, shot := range writes {
		if old, ok := byID[shot.ID]; ok {
			for _, ref := range old.Content.SourceReferences {
				if !scope[ref.ParagraphID] {
					return BadAuthRequest("局部修改范围必须覆盖该镜头原有来源，不能通过缩小范围丢弃内容")
				}
			}
		}
		for _, ref := range shot.Content.SourceReferences {
			if !scope[ref.ParagraphID] {
				return BadAuthRequest("镜头引用超出本次sourceParagraphIds范围")
			}
		}
		byID[shot.ID] = shot
	}
	combined := []model.Shot{}
	for _, shot := range byID {
		combined = append(combined, shot)
	}
	// A local scope cannot reorder its speech across an unchanged neighbouring
	// shot. Gaps are allowed while authoring a partial chapter, reversal is not.
	order := map[string]int{}
	for i, p := range paragraphs {
		order[p.ID] = i
	}
	sort.Slice(combined, func(i, j int) bool { return combined[i].Position < combined[j].Position })
	last := -1
	for _, shot := range combined {
		for _, line := range shot.Content.Dialogue {
			position, exists := order[line.ParagraphID]
			if !exists || position < last {
				return BadAuthRequest("局部改镜不能颠倒与未改镜头之间的对白顺序")
			}
			last = position
		}
	}
	coverage := shotSourceCoverage(paragraphs, combined, scope)
	if len(coverage.MissingParagraphIDs) != 0 {
		return BadAuthRequest("来源未完整覆盖，整批未保存：" + strings.Join(coverage.MissingParagraphIDs, ","))
	}
	if !coverage.DialogueMatches {
		return BadAuthRequest("对白遗漏、重复、顺序、说话人或原文不匹配，整批未保存")
	}
	return nil
}
