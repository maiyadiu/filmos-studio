export function safeAuthNext(value: string | null) {
    if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return "/create";
    try {
        const target = new URL(value, "https://filmos.invalid");
        const pathname = decodeURIComponent(target.pathname).replace(/\/+$/, "").toLowerCase();
        if (target.origin !== "https://filmos.invalid" || pathname === "/login" || pathname === "/register") return "/create";
        return target.pathname + target.search + target.hash;
    } catch {
        return "/create";
    }
}
