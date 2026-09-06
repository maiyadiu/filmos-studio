export type ChapterDocumentView = "readable" | "markdown";

export { documentTextFromHtml } from "@/lib/document-text";

export function parseChapterDocumentView(value: string | null | undefined): ChapterDocumentView {
    return value === "markdown" ? "markdown" : "readable";
}
