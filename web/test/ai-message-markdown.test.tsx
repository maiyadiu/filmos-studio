import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AIMessageMarkdown } from "../src/components/ai/ai-message-markdown";
import { documentTextFromHtml } from "../src/lib/document-text";

test("readable Chinese dialogue handles punctuation inside emphasis without rewriting source", () => {
    const source = "## 纸船等风\n\n**青禾：**等风来再放。\n\n**阿川：**那我陪你等。";
    const html = renderToStaticMarkup(<AIMessageMarkdown>{documentTextFromHtml(source)}</AIMessageMarkdown>);
    expect(html).toContain('data-streamdown="strong">青禾：</span>等风来再放。');
    expect(html).toContain('data-streamdown="strong">阿川：</span>那我陪你等。');
    expect(html).not.toContain("**青禾：**");
    expect(html).toContain("ai-message-markdown-heading");
    expect(source).toContain("**青禾：**");
});

test("existing GFM tables and safe literal code survive the CJK plugin", () => {
    const html = renderToStaticMarkup(<AIMessageMarkdown>{"| 项目 | 版本 |\n| --- | --- |\n| 正文 | v1 |\n\n`**青禾：**`\n\n<script>alert(1)</script>"}</AIMessageMarkdown>);
    expect(html).toContain("<table");
    expect(html).toContain("正文");
    expect(html).toContain("**青禾：**</code>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('data-streamdown="strong">青禾：');
});
