import { describe, expect, test } from "bun:test";

import { createLocalAccountBindingRefResolver } from "@/film/generation-routing/local-account-binding-ref";

describe("local account binding references", () => {
    test("uses a local-secret HMAC instead of an ordinary source hash", async () => {
        const source = "provider-account-cookie-or-cli-binding";
        const firstDevice = createLocalAccountBindingRefResolver(async () => new Uint8Array(32).fill(1));
        const secondDevice = createLocalAccountBindingRefResolver(async () => new Uint8Array(32).fill(2));

        const first = await firstDevice("dreamina_cli", source);
        expect(await firstDevice("dreamina_cli", source)).toBe(first);
        expect(await secondDevice("dreamina_cli", source)).not.toBe(first);
        expect(await firstDevice("flova_cli", source)).not.toBe(first);
        expect(first).toMatch(/^filmos_acct_[0-9a-f-]{36}$/);
        expect(first).not.toContain(source);
    });
});
