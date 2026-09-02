import assert from "node:assert/strict";
import { test } from "node:test";

import { DesktopRpcClient } from "../src/film/adapters/yingce/desktop-rpc-client";
import { DesktopRpcError, assertDesktopRpcPayloadSize, normalizeDesktopRpcError } from "../src/film/contracts/desktop-rpc";

function harness() {
    const messages: unknown[] = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const client = new DesktopRpcClient({
        postMessage: (message) => messages.push(message),
        randomUUID: () => "11111111-1111-4111-8111-111111111111",
        setTimer: (callback) => {
            const id = nextTimer++;
            timers.set(id, callback);
            return id;
        },
        clearTimer: (timer) => timers.delete(timer),
    });
    return { client, messages, timers };
}

test("ChatGPT and Review Bus share one request lifecycle without changing legacy action names", async () => {
    const { client, messages } = harness();
    const chatGPT = client.request({ action: "chatgptHostRequest", operation: "publish_context", payload: { project_id: "project-1" } }, {
        timeoutMs: 15_000,
        timeoutCode: "CHATGPT_DESKTOP_SECURE_BRIDGE_TIMEOUT",
        unavailableCode: "CHATGPT_DESKTOP_SECURE_BRIDGE_UNAVAILABLE",
    });
    assert.equal(client.pendingCount, 1);
    assert.deepEqual(messages[0], {
        action: "chatgptHostRequest",
        operation: "publish_context",
        payload: { project_id: "project-1" },
        requestId: "11111111-1111-4111-8111-111111111111",
    });
    assert.equal(client.resolve("11111111-1111-4111-8111-111111111111", { ok: true }), true);
    assert.deepEqual(await chatGPT, { ok: true });
    assert.equal(client.pendingCount, 0);
});

test("timeout and native failures preserve secure error codes and retry classification", async () => {
    const { client, timers } = harness();
    const timeout = client.request({ action: "reviewCenterRequest", operation: "list_issues", payload: {} }, {
        timeoutMs: 15_000,
        timeoutCode: "REVIEW_CENTER_TIMEOUT",
        unavailableCode: "REVIEW_BUS_UNAVAILABLE",
    });
    timers.values().next().value?.();
    await assert.rejects(timeout, (error: unknown) => error instanceof DesktopRpcError && error.code === "REVIEW_CENTER_TIMEOUT" && error.retryClass === "retryable");

    const nativeFailure = client.request({ action: "reviewIssueRequest", payload: {} }, {
        timeoutMs: 20_000,
        timeoutCode: "REVIEW_BUS_TIMEOUT",
        unavailableCode: "REVIEW_BUS_UNAVAILABLE",
    });
    client.resolve("11111111-1111-4111-8111-111111111111", null, "REVIEW_BUS_INVALID_REQUEST");
    await assert.rejects(nativeFailure, (error: unknown) => error instanceof DesktopRpcError && error.code === "REVIEW_BUS_INVALID_REQUEST" && error.retryClass === "non_retryable");
});

test("oversized payloads fail before crossing the native boundary", () => {
    assert.throws(() => assertDesktopRpcPayloadSize({
        action: "chatgptHostRequest",
        operation: "publish_context",
        payload: { body: "x".repeat(256 * 1024) },
    }), (error: unknown) => error instanceof DesktopRpcError && error.code === "DESKTOP_RPC_PAYLOAD_TOO_LARGE");
});

test("untrusted native errors never escape the bounded error envelope", () => {
    assert.deepEqual(normalizeDesktopRpcError("../../Users/example/token", "DESKTOP_RPC_FAILED"), {
        code: "DESKTOP_RPC_FAILED",
        retryClass: "non_retryable",
    });
});
