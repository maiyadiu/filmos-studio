import { expect, test } from "bun:test";
import { FilmCoreHttpProductionGenerationAuthority } from "@/film/generation-routing/film-core-production-authority";

test("Film Core field errors retain their code and show a safe actionable field", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ detail: {
        code: "generation_production_field_invalid", message: "bindings.projectLock must be an object",
    } }), { status: 409 })) as typeof fetch;
    const authority = new FilmCoreHttpProductionGenerationAuthority(async () => new Map(), undefined, fetcher);
    try {
        await authority.ensureProjectAuthority("fixture", "fixture", {});
        throw new Error("expected failure");
    } catch (error) {
        expect(error).toMatchObject({ code: "generation_production_field_invalid" });
        expect((error as Error).message).toContain("未保存：bindings.projectLock");
    }
});

test("Film Core does not echo arbitrary server text or sensitive local paths", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ detail: {
        code: "generation_production_field_invalid", message: "/Users/private/secret apiKey=value",
    } }), { status: 409 })) as typeof fetch;
    const authority = new FilmCoreHttpProductionGenerationAuthority(async () => new Map(), undefined, fetcher);
    await expect(authority.loadProjectAuthority("fixture")).rejects.toThrow("生成配置字段不完整");
    try { await authority.loadProjectAuthority("fixture"); } catch (error) {
        expect((error as Error).message).not.toContain("/Users/");
        expect((error as Error).message).not.toContain("apiKey");
    }
});
