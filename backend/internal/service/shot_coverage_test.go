package service

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"testing"
)

func TestShotCoverageRejectsOmissionDuplicationAndWrongSpeaker(t *testing.T) {
	for _, failure := range []string{"missing-dialogue", "duplicate-dialogue", "wrong-speaker", "missing-action", "partial-quote", "missing-scope", "unknown-scope", "reused-scope"} {
		t.Run(failure, func(t *testing.T) {
			s, db := shotTestService(t)
			req := shotTestRequest()
			switch failure {
			case "missing-dialogue":
				req.Shots[0].Content.Dialogue = nil
			case "duplicate-dialogue":
				req.Shots[0].Content.Dialogue = append(req.Shots[0].Content.Dialogue, req.Shots[0].Content.Dialogue[0])
			case "wrong-speaker":
				req.Shots[0].Content.Dialogue[0].Speaker = "林"
			case "missing-action":
				req.Shots = req.Shots[:1]
			case "partial-quote":
				req.Shots[1].Content.SourceReferences[0].Quote = "林夏关门"
			case "missing-scope":
				req.SourceParagraphIDs = nil
			case "unknown-scope":
				req.SourceParagraphIDs[0] = "fake"
			case "reused-scope":
				req.SourceParagraphIDs[1] = req.SourceParagraphIDs[0]
			}
			if _, err := s.SaveProjectUnitShots("u", "p", "chapter", req); err == nil {
				t.Fatal("invalid source coverage accepted")
			}
			var count int64
			db.Model(&model.Shot{}).Count(&count)
			if count != 0 {
				t.Fatal("invalid coverage wrote shots")
			}
		})
	}
}

func TestShotCoverageSplitSpeechAndPartialScope(t *testing.T) {
	s, _ := shotTestService(t)
	req := shotTestRequest()
	req.SourceParagraphIDs = []string{"p0001", "p0002"}
	first := req.Shots[0]
	second := first
	first.Content.Dialogue = []model.ShotDialogue{{Speaker: "林夏", Text: "我陪", ParagraphID: "p0002"}}
	second.Content.Dialogue = []model.ShotDialogue{{Speaker: "林夏", Text: "你。", ParagraphID: "p0002"}}
	second.Position = 1
	req.Shots = []ProjectShotWriteRequest{first, second}
	if _, err := s.SaveProjectUnitShots("u", "p", "chapter", req); err != nil {
		t.Fatal(err)
	}
	ctx, _ := s.GetProjectShotContext("u", "p", "chapter")
	if ctx.Coverage.ChapterComplete || !ctx.Coverage.DialogueMatches || len(ctx.Coverage.MissingParagraphIDs) != 1 || ctx.Coverage.MissingParagraphIDs[0] != "p0003" {
		t.Fatalf("partial work called complete: %+v", ctx.Coverage)
	}
	add := shotTestRequest()
	add.RequestID = "append-action"
	add.ExpectedShotRevision = &ctx.Unit.ShotRevision
	add.SourceParagraphIDs = []string{"p0003"}
	add.Shots = add.Shots[1:]
	add.Shots[0].Position = 2
	if _, err := s.SaveProjectUnitShots("u", "p", "chapter", add); err != nil {
		t.Fatal(err)
	}
	ctx, _ = s.GetProjectShotContext("u", "p", "chapter")
	if !ctx.Coverage.ChapterComplete {
		t.Fatalf("full coverage not recognized: %+v", ctx.Coverage)
	}
	edit := req
	edit.RequestID = "drop-original-scope"
	edit.ExpectedShotRevision = &ctx.Unit.ShotRevision
	edit.SourceParagraphIDs = []string{"p0002"}
	edit.Shots = edit.Shots[:1]
	edit.Shots[0].ID, edit.Shots[0].ExpectedRevision = ctx.Shots[0].ID, ctx.Shots[0].Revision
	if _, err := s.SaveProjectUnitShots("u", "p", "chapter", edit); err == nil {
		t.Fatal("shrinking an existing shot source silently accepted")
	}
}

func TestShotCoverageRejectsOrderAcrossUnchangedShot(t *testing.T) {
	s, db := shotTestService(t)
	source := "<p>林夏：我陪你。</p><p>周宁：好。</p>"
	db.Model(&model.ProjectUnit{}).Where("id = ?", "chapter").Update("source_text", source)
	req := shotTestRequest()
	req.SourceHash = repository.ScriptSourceHash(source)
	req.SourceParagraphIDs = []string{"p0001", "p0002"}
	for i, line := range []model.ShotDialogue{{Speaker: "林夏", Text: "我陪你。", ParagraphID: "p0001"}, {Speaker: "周宁", Text: "好。", ParagraphID: "p0002"}} {
		req.Shots[i].Content.SourceReferences = []model.ShotSourceReference{{ParagraphID: line.ParagraphID, Quote: line.Speaker + "：" + line.Text}}
		req.Shots[i].Content.Characters = []string{line.Speaker}
		req.Shots[i].Content.Dialogue = []model.ShotDialogue{line}
	}
	first, err := s.SaveProjectUnitShots("u", "p", "chapter", req)
	if err != nil {
		t.Fatal(err)
	}
	edit := req
	edit.RequestID = "move-first-after-second"
	one := int64(1)
	edit.ExpectedShotRevision = &one
	edit.SourceParagraphIDs = []string{"p0001"}
	edit.Shots = edit.Shots[:1]
	edit.Shots[0].ID, edit.Shots[0].ExpectedRevision = first.Receipt.Shots[0].ID, 1
	edit.Shots[0].Position = 2
	if _, err := s.SaveProjectUnitShots("u", "p", "chapter", edit); err == nil {
		t.Fatal("reversed speech across unchanged shot")
	}
}

func TestShotSourceParagraphRolesAndExactWhitespace(t *testing.T) {
	p := scriptParagraphs("<h2>场景：客厅</h2><p>动作：林夏放下杯子。</p><p><strong>林夏（低声）</strong>：  我&amp;你。</p><p>旁白：雨停了。</p><script>不可见正文</script>")
	if len(p) != 4 || p[0].Dialogue != nil || p[1].Dialogue != nil || p[2].Dialogue == nil || p[2].Dialogue.Speaker != "林夏" || p[2].Dialogue.Text != "  我&你。" || p[3].Dialogue.Speaker != "旁白" {
		t.Fatalf("source parser: %+v", p)
	}
}

func TestShotSourceMarkdownLabelsAreNotSpeakers(t *testing.T) {
	p := scriptParagraphs("# 雨夜账本\n\n**场景：旧书店。**\n\n**林夏**：我陪你。\n\n**周宁：**好。\n\n**林夏：一起。**")
	if len(p) != 5 || p[0].Dialogue != nil || p[1].Dialogue != nil || p[1].Text != "**场景：旧书店。**" {
		t.Fatalf("markdown header misclassified: %+v", p)
	}
	for i, expected := range []model.ShotDialogue{{Speaker: "林夏", Text: "我陪你。", ParagraphID: "p0003"}, {Speaker: "周宁", Text: "好。", ParagraphID: "p0004"}, {Speaker: "林夏", Text: "一起。", ParagraphID: "p0005"}} {
		if p[i+2].Dialogue == nil || *p[i+2].Dialogue != expected {
			t.Fatalf("formatted dialogue: %+v", p[i+2])
		}
	}
}
