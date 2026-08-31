import { describe, expect, test } from "bun:test";

import { chapterDocumentViewPreferenceKey, markdownToSourceHtml, readChapterDocumentView, sourceHtmlToMarkdown, writeChapterDocumentView } from "../src/pages/projects/detail/chapter-document-view";

describe("chapter document view", () => {
    test("defaults to readable and stores a project-scoped preference", () => {
        const values = new Map<string, string>();
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
        };
        expect(readChapterDocumentView("project-a", storage)).toBe("readable");
        writeChapterDocumentView("project-a", "markdown", storage);
        expect(values.get(chapterDocumentViewPreferenceKey("project-a"))).toBe("markdown");
        expect(readChapterDocumentView("project-a", storage)).toBe("markdown");
        expect(readChapterDocumentView("project-b", storage)).toBe("readable");
    });

    test("projects wrapped Markdown into a safe readable document", () => {
        const source = markdownToSourceHtml("# 标题\n\n**粗体**、*斜体*与 `code`\n\n- 第一项\n- 第二项");
        const projection = sourceHtmlToMarkdown(source);
        expect(projection.markdown).toBe("# 标题\n\n**粗体**、*斜体*与 `code`\n\n- 第一项\n- 第二项");
        expect(projection.plainText).toContain("标题");
        expect(projection.degraded).toBe(false);
    });

    test("preserves supported HTML semantics during Markdown round trips", () => {
        const projection = sourceHtmlToMarkdown('<h2>章节</h2><p><strong>重点</strong>与<a href="https://example.com">链接</a></p><ol><li>一</li><li>二</li></ol>');
        expect(projection.markdown).toBe("## 章节\n\n**重点**与[链接](https://example.com)\n\n1. 一\n2. 二");
        expect(sourceHtmlToMarkdown(markdownToSourceHtml(projection.markdown)).markdown).toBe(projection.markdown);
    });

    test("reports explicit degradation for styling that Markdown cannot preserve", () => {
        const projection = sourceHtmlToMarkdown('<p><span style="color:#f00">红色</span><mark>高亮</mark></p>');
        expect(projection.markdown).toBe("红色高亮");
        expect(projection.degraded).toBe(true);
        expect(projection.degradationReasons).toContain("颜色、高亮或自定义样式将转为纯 Markdown");
        expect(projection.degradationReasons).toContain("不支持的富文本标签：mark");
    });

    test("does not turn unsafe links into clickable Markdown", () => {
        expect(sourceHtmlToMarkdown('<p><a href="javascript:alert(1)">危险</a></p>').markdown).toBe("危险");
    });
});
