package service

import (
	"fmt"
	"io"
	"regexp"
	"strings"

	"golang.org/x/net/html"
	"infinite-canvas/backend/internal/model"
)

type ScriptParagraph struct {
	ID       string              `json:"id"`
	Text     string              `json:"text"`
	Dialogue *model.ShotDialogue `json:"dialogue,omitempty"`
}

var scriptHTMLBlock = regexp.MustCompile(`(?i)<(?:p|div|h[1-6]|br|li|blockquote)(?:\s|/?>)`)
var scriptDialogueLine = regexp.MustCompile(`^([^：:\n]{1,24})[：:](.+)$`)
var scriptNonDialogueLabel = regexp.MustCompile(`^(场景|时间|地点|内景|外景|动作|人物|角色|环境|画面|镜头|音效|音乐|转场|备注|道具|设定|标题|章节|场次)$`)

// IDs are scoped by the chapter revision/hash, not globally stable across edits.
// Do not ask the model to invent offsets or use a canvas summary as the source.
func scriptParagraphs(source string) []ScriptParagraph {
	plain := source
	if scriptHTMLBlock.MatchString(source) {
		var text strings.Builder
		tokens := html.NewTokenizer(strings.NewReader(source))
		skip := false
		for {
			kind := tokens.Next()
			if kind == html.ErrorToken {
				if tokens.Err() == io.EOF {
					break
				}
				break
			}
			token := tokens.Token()
			if kind == html.StartTagToken && (token.Data == "script" || token.Data == "style") {
				skip = true
			}
			if kind == html.EndTagToken && (token.Data == "script" || token.Data == "style") {
				skip = false
				continue
			}
			if skip {
				continue
			}
			if kind == html.TextToken {
				text.WriteString(token.Data)
			}
			if kind == html.StartTagToken || kind == html.EndTagToken || kind == html.SelfClosingTagToken {
				switch token.Data {
				case "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "br", "li", "blockquote":
					text.WriteString("\n")
				}
			}
		}
		plain = text.String()
	}
	paragraphs := []ScriptParagraph{}
	for _, line := range strings.Split(strings.ReplaceAll(plain, "\r\n", "\n"), "\n") {
		if text := strings.TrimSpace(line); text != "" {
			p := ScriptParagraph{ID: fmt.Sprintf("p%04d", len(paragraphs)+1), Text: text}
			if match := scriptDialogueLine.FindStringSubmatch(unwrapScriptFormatting(text)); match != nil {
				speaker := unwrapScriptFormatting(strings.TrimSpace(match[1]))
				for _, marker := range []string{"**", "__", "*", "_"} {
					if strings.HasPrefix(speaker, marker) && strings.HasPrefix(match[2], marker) {
						speaker = strings.TrimPrefix(speaker, marker)
						match[2] = strings.TrimPrefix(match[2], marker)
					}
				}
				// Delivery directions remain in the exact source, not character identity.
				if i := strings.IndexAny(speaker, "（("); i > 0 {
					speaker = strings.TrimSpace(speaker[:i])
				}
				if speaker != "" && !scriptNonDialogueLabel.MatchString(speaker) {
					p.Dialogue = &model.ShotDialogue{Speaker: speaker, Text: match[2], ParagraphID: p.ID}
				}
			}
			paragraphs = append(paragraphs, p)
		}
	}
	return paragraphs
}

// Formatting around a whole line or speaker label is not spoken text. Keep
// ScriptParagraph.Text unchanged for exact source references and source hashes.
func unwrapScriptFormatting(text string) string {
	for _, marker := range []string{"**", "__", "*", "_", "`"} {
		if len(text) > len(marker)*2 && strings.HasPrefix(text, marker) && strings.HasSuffix(text, marker) {
			text = text[len(marker) : len(text)-len(marker)]
		}
	}
	return text
}

func validateShotContent(content model.ShotContent, paragraphs []ScriptParagraph) error {
	if len(content.SourceReferences) == 0 || len(content.SourceReferences) > 200 || len(content.Characters) > 100 || len(content.Dialogue) > 200 || strings.TrimSpace(content.Scene) == "" || strings.TrimSpace(content.Action) == "" || strings.TrimSpace(content.Camera) == "" {
		return BadAuthRequest("镜头必须提供来源、场景、动作和镜头要求，且不能超过条目限制")
	}
	byID := map[string]string{}
	dialogueByID := map[string]*model.ShotDialogue{}
	for _, p := range paragraphs {
		byID[p.ID] = p.Text
		dialogueByID[p.ID] = p.Dialogue
	}
	referenced := map[string]bool{}
	for _, ref := range content.SourceReferences {
		text, ok := byID[ref.ParagraphID]
		if !ok || strings.TrimSpace(ref.Quote) == "" || strings.Count(text, ref.Quote) != 1 {
			return BadAuthRequest("来源段落不存在或引用不唯一；请使用读取返回的段落ID和精确原文")
		}
		referenced[ref.ParagraphID] = true
	}
	for _, line := range content.Dialogue {
		source := dialogueByID[line.ParagraphID]
		if !referenced[line.ParagraphID] || source == nil || source.Speaker != line.Speaker || strings.TrimSpace(line.Text) == "" || !strings.Contains(source.Text, line.Text) {
			return BadAuthRequest("对白、说话人或来源不匹配，不允许改写剧本对白")
		}
	}
	for _, name := range content.Characters {
		found := false
		for _, p := range paragraphs {
			if strings.TrimSpace(name) != "" && strings.Contains(p.Text, name) {
				found = true
				break
			}
		}
		if !found {
			return BadAuthRequest("角色名称未出现在来源正文中，不能虚构角色或资产ID")
		}
	}
	return nil
}
