export type ChapterDocumentView = "readable" | "markdown";

export function documentTextFromHtml(value: string) {
    return value
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(?:p|div|h[1-6]|blockquote|li)>/gi, "\n\n")
        .replace(/<li[^>]*>/gi, "- ")
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
