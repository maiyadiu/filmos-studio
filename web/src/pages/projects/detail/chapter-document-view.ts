export type ChapterDocumentView = "readable" | "markdown";

export type ChapterMarkdownProjection = {
    markdown: string;
    plainText: string;
    degraded: boolean;
    degradationReasons: string[];
};

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

const supportedTags = new Set(["a", "b", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "li", "ol", "p", "pre", "s", "strike", "strong", "ul"]);

export function chapterDocumentViewPreferenceKey(projectId: string) {
    return `project-chapter-document-view:${projectId}`;
}

export function readChapterDocumentView(projectId: string, storage: StorageReader | null = browserStorage()): ChapterDocumentView {
    const value = storage?.getItem(chapterDocumentViewPreferenceKey(projectId));
    return value === "markdown" ? "markdown" : "readable";
}

export function writeChapterDocumentView(projectId: string, view: ChapterDocumentView, storage: StorageWriter | null = browserStorage()) {
    storage?.setItem(chapterDocumentViewPreferenceKey(projectId), view);
}

export function sourceHtmlToMarkdown(sourceHtml: string): ChapterMarkdownProjection {
    if (!sourceHtml.trim()) return { markdown: "", plainText: "", degraded: false, degradationReasons: [] };

    const degradationReasons = collectDegradations(sourceHtml);
    let value = sourceHtml
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
        .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, content: string) => `\n\n\`\`\`\n${decodeEntities(stripTags(content)).trim()}\n\`\`\`\n\n`)
        .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, content: string) => `\`${decodeEntities(stripTags(content)).replace(/`/g, "\\`")}\``)
        .replace(/<a\b[^>]*href=(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_, doubleHref: string, singleHref: string, bareHref: string, content: string) => {
            const href = decodeEntities(doubleHref || singleHref || bareHref || "");
            const label = decodeEntities(stripTags(content)).trim() || href;
            return safeLink(href) ? `[${label}](${href})` : label;
        })
        .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
        .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
        .replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, "~~$2~~")
        .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, content: string) => `\n\n${"#".repeat(Number(level))} ${stripTags(content).trim()}\n\n`)
        .replace(
            /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
            (_, content: string) =>
                `\n\n${decodeEntities(stripTags(content))
                    .trim()
                    .split(/\r?\n/)
                    .map((line) => `> ${line}`)
                    .join("\n")}\n\n`,
        )
        .replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, content: string) => listToMarkdown(content, true))
        .replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_, content: string) => listToMarkdown(content, false))
        .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, content: string) => `\n- ${stripTags(content).trim()}`)
        .replace(/<hr\b[^>]*\/?\s*>/gi, "\n\n---\n\n")
        .replace(/<br\b[^>]*\/?\s*>/gi, "\n")
        .replace(/<(p|div)\b[^>]*>([\s\S]*?)<\/\1>/gi, "\n\n$2\n\n")
        .replace(/<[^>]+>/g, "");

    value = normalizeMarkdown(decodeEntities(value));
    return {
        markdown: value,
        plainText: markdownPlainText(value),
        degraded: degradationReasons.length > 0,
        degradationReasons,
    };
}

export function markdownToSourceHtml(markdown: string) {
    const escaped = markdown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return escaped
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
        .join("");
}

export function markdownPlainText(markdown: string) {
    return markdown
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/^\s*(?:[-+*]|\d+\.)\s+/gm, "")
        .replace(/^\s*>\s?/gm, "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/(?:\*\*|__|~~|`)/g, "")
        .replace(/^\s*```.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim();
}

function collectDegradations(sourceHtml: string) {
    const reasons = new Set<string>();
    for (const match of sourceHtml.matchAll(/<\/?([A-Za-z][\w:-]*)\b([^>]*)>/g)) {
        const tag = match[1].toLowerCase();
        const attributes = match[2] || "";
        if (!supportedTags.has(tag)) reasons.add(`不支持的富文本标签：${tag}`);
        if (/\b(?:style|color|data-color|data-highlight)=/i.test(attributes)) reasons.add("颜色、高亮或自定义样式将转为纯 Markdown");
    }
    return Array.from(reasons).sort();
}

function listToMarkdown(content: string, ordered: boolean) {
    let index = 0;
    const items = Array.from(content.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)).map((match) => {
        index += 1;
        return `${ordered ? `${index}.` : "-"} ${decodeEntities(stripTags(match[1])).trim()}`;
    });
    return items.length ? `\n\n${items.join("\n")}\n\n` : `\n\n${decodeEntities(stripTags(content)).trim()}\n\n`;
}

function stripTags(value: string) {
    return value.replace(/<br\b[^>]*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "");
}

function safeLink(value: string) {
    return /^(?:https?:|mailto:|\/|#)/i.test(value);
}

function normalizeMarkdown(value: string) {
    return value
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function decodeEntities(value: string) {
    const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
    return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, key: string) => {
        if (key[0] === "#") {
            const radix = key[1]?.toLowerCase() === "x" ? 16 : 10;
            const digits = radix === 16 ? key.slice(2) : key.slice(1);
            const codePoint = Number.parseInt(digits, radix);
            return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
        }
        return named[key.toLowerCase()] ?? entity;
    });
}

function browserStorage(): Storage | null {
    return typeof window === "undefined" ? null : window.localStorage;
}
