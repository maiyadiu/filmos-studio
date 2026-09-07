// Mirrors the server's display-only naming rule. The server resolves and
// authorizes the real directory; this preview grants no filesystem access.
export async function projectDirectoryPreview(parent: string, name: string, userId: string, requestId: string): Promise<string> {
    const title = name.trim();
    if (!parent || !title || !userId || !requestId) return "";
    if ([...title].length > 80 || title.startsWith(".") || title.endsWith(".") || /[/\\:\x00\r\n\t]/.test(title)) return "";
    const bytes = new TextEncoder().encode(`${userId}\0${requestId}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const suffix = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 8);
    return `${parent.replace(/\/$/, "")}/${title}-${suffix}`;
}
