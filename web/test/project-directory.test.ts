import { describe, expect, test } from "bun:test";
import { projectDirectoryPreview } from "../src/lib/project-directory";

describe("project directory display contract", () => {
    test("stable per-user per-request identity matches server SHA256", async () => {
        const expected = new Bun.CryptoHasher("sha256").update("user\0request").digest("hex").slice(0, 8);
        expect(await projectDirectoryPreview("/下载/", " 中文 空格 ", "user", "request")).toBe(`/下载/中文 空格-${expected}`);
        expect(await projectDirectoryPreview("/下载", "同名", "user", "one")).not.toBe(await projectDirectoryPreview("/下载", "同名", "user", "two"));
    });
    test("missing identities and invalid names are never presented as authorized paths", async () => {
        for (const name of ["../逃逸", "a/b", ".hidden", "a\\b", "a:", "x".repeat(81)]) expect(await projectDirectoryPreview("/下载", name, "u", "r")).toBe("");
        expect(await projectDirectoryPreview("/下载", "合法", "", "r")).toBe("");
    });
});
