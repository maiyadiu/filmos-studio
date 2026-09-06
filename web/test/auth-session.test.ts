import { afterEach, expect, test } from "bun:test";
import { getAuthSession } from "../src/services/api/auth";
import { apiClient } from "../src/services/api/request";
import { safeAuthNext } from "../src/lib/auth-next-path";

const originalAdapter = apiClient.defaults.adapter;
afterEach(() => { apiClient.defaults.adapter = originalAdapter; });

test("session failure stays rejected and retries without anonymous cache", async () => {
    let calls = 0;
    apiClient.defaults.adapter = async (config) => {
        calls += 1;
        expect(config.timeout).toBe(15_000);
        if (calls === 1) throw new Error("offline");
        return { data: { code: 0, data: { user: null, authMode: "account" }, msg: "ok" }, status: 200, statusText: "OK", headers: {}, config };
    };
    await expect(getAuthSession({ refresh: true })).rejects.toThrow("offline");
    expect(await getAuthSession()).toEqual({ user: null, authMode: "account" });
    expect(calls).toBe(2);
});

test("refresh retries server identity instead of reusing cached guest", async () => {
    let calls = 0;
    apiClient.defaults.adapter = async (config) => ({
        data: { code: 0, data: ++calls === 1 ? { user: null, authMode: "account" } : { user: { id: "local-fixture", role: "admin" }, authMode: "desktop_local" }, msg: "ok" },
        status: 200, statusText: "OK", headers: {}, config,
    });
    expect((await getAuthSession({ refresh: true })).user).toBeNull();
    expect((await getAuthSession()).user).toBeNull();
    expect((await getAuthSession({ refresh: true })).user?.id).toBe("local-fixture");
    expect(calls).toBe(2);
});

test("missing session payload and unestablished local user never become guest", async () => {
    for (const data of [undefined, "bad", {}, { user: undefined }, { user: false }, { user: {} }, { user: { id: "" } }, { authMode: "desktop_local", user: null }]) {
        apiClient.defaults.adapter = async (config) => ({ data: { code: 0, data, msg: "ok" }, status: 200, statusText: "OK", headers: {}, config });
        await expect(getAuthSession({ refresh: true })).rejects.toThrow("工作台身份尚未建立");
    }
});

test("authenticated entry preserves internal target without external or auth redirect loops", () => {
    for (const value of [null, "https://example.com", "//example.com", "/\\example.com", "/\n/evil", "/login?next=/create", "/register/", "/login#x", "/folder/../login", "/%6Cogin", "/REGISTER", "/%xx"]) expect(safeAuthNext(value)).toBe("/create");
    expect(safeAuthNext("/canvas/example?focus=shot#history")).toBe("/canvas/example?focus=shot#history");
});

test("server error status survives session lookup", async () => {
    apiClient.defaults.adapter = async (config) => ({ data: { code: 503, data: null, msg: "服务暂时不可用" }, status: 503, statusText: "Unavailable", headers: {}, config });
    await expect(getAuthSession({ refresh: true })).rejects.toMatchObject({ status: 503, code: 503 });
});
