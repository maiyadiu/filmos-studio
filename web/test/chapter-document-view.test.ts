import { describe, expect, test } from "bun:test";

import { documentTextFromHtml, parseChapterDocumentView } from "../src/pages/projects/detail/chapter-document-view";

describe("chapter document dual view", () => {
    test("readable mode and Markdown mode share one canonical text projection", () => {
        expect(documentTextFromHtml("<h1>标题</h1><p>**重点** &amp; 内容</p><ul><li>第一项</li><li>第二项</li></ul>"))
            .toBe("# 标题\n\n**重点** & 内容\n\n- 第一项\n- 第二项");
        expect(documentTextFromHtml("<p><strong>粗体</strong> <em>斜体</em> <code>raw</code></p>"))
            .toBe("**粗体** *斜体* `raw`");
    });

    test("unknown or absent preferences fail back to readable mode", () => {
        expect(parseChapterDocumentView("markdown")).toBe("markdown");
        expect(parseChapterDocumentView("readable")).toBe("readable");
        expect(parseChapterDocumentView("unknown")).toBe("readable");
        expect(parseChapterDocumentView(null)).toBe("readable");
    });

    test("chapter previews preserve scene action and dialogue paragraph boundaries", () => {
        const source = "<p>场景：渡口值班室。</p><p>动作：许照放下笔。</p><p>许照：我等。</p><p>沈禾：一起等。</p><p>动作：灯一直亮着。</p>";
        const readable = documentTextFromHtml(source);
        expect(readable.split("\n\n")).toEqual(["场景：渡口值班室。", "动作：许照放下笔。", "许照：我等。", "沈禾：一起等。", "动作：灯一直亮着。"]);
        expect(readable).not.toContain("<p>");
        expect(source).toContain("</p><p>");
        const markdown = "## 渡口\n\n**场景：**夜。\n\n- 一盏灯\n- 一本账本\n\n沈禾：一起等。";
        expect(documentTextFromHtml(markdown)).toBe(markdown);
    });
});
