export type ChapterDocumentView = "readable" | "markdown";

export function documentTextFromHtml(value: string) {
    return value
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<(?:strong|b)[^>]*>/gi, "**")
        .replace(/<\/(?:strong|b)>/gi, "**")
        .replace(/<(?:em|i)[^>]*>/gi, "*")
        .replace(/<\/(?:em|i)>/gi, "*")
        .replace(/<code[^>]*>/gi, "`")
        .replace(/<\/code>/gi, "`")
        .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
        .replace(/<h([1-6])[^>]*>/gi, (_match, level: string) => `${"#".repeat(Number(level))} `)
        .replace(/<\/(?:p|div|h[1-6]|blockquote)>/gi, "\n\n")
        .replace(/<li[^>]*>/gi, "- ")
        .replace(/<\/li>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&amp;/gi, "&")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export function parseChapterDocumentView(value: string | null | undefined): ChapterDocumentView {
    return value === "markdown" ? "markdown" : "readable";
}
