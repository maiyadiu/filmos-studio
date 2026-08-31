import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

import { pairBridge, parseDecisionCandidates, sendDecision, validateEnvelope } from "../src/protocol.mjs";

const envelope = { purpose: "CHATGPT_VERDICT", issue_id: "FILMOS-ISSUE-test", candidate_id: "candidate-1", candidate_commit: "a".repeat(40), decision: { verdict: "EXTERNAL_APPROVED" } };

test("Manifest V3 has only local bridge hosts and no cookie permission", () => {
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "../manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*", "http://127.0.0.1:17920/*"]);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal(JSON.stringify(manifest).includes("cookies"), false);
});

test("options use a six-digit one-time pairing code and never ask for a raw bridge token", async () => {
  const html = readFileSync(resolve(import.meta.dirname, "../options.html"), "utf8");
  assert.match(html, /6位配对码/);
  assert.equal(html.includes("Pairing Token"), false);
  let request;
  const receipt = await pairBridge({ pairingCode: "123456", fetchImpl: async (url, init) => {
    request = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ client_id: "bridge-client-1", bridge_session_token: "bridge-session-1234567890-abcdefghijkl" }), { status: 201, headers: { "content-type": "application/json" } });
  } });
  assert.match(request.url, /\/v1\/bridge\/pair$/);
  assert.equal(request.body.pairing_code, "123456");
  assert.equal(receipt.client_id, "bridge-client-1");
  await assert.rejects(() => pairBridge({ pairingCode: "token-token-token" }), /INVALID_PAIRING_CODE/);
});

test("writeback requires a fresh user gesture and uses challenge before decision", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return calls.length === 1
      ? new Response(JSON.stringify({ challenge_id: "review_challenge_1", nonce: "review_nonce_1" }), { status: 201, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ ack: true, issue_id: envelope.issue_id }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(() => sendDecision(envelope, { token: "token-token-token-token-token", userGestureAt: 1, now: 10_000, fetchImpl }), /CHROME_USER_GESTURE_REQUIRED/);
  const ack = await sendDecision(envelope, { token: "token-token-token-token-token", userGestureAt: 9_000, now: 10_000, fetchImpl });
  assert.equal(ack.ack, true);
  assert.match(calls[0].url, /\/challenge$/);
  assert.match(calls[1].url, /\/decision$/);
  assert.equal(calls[1].body.nonce, "review_nonce_1");
});

test("decision envelope rejects extra fields and wrong commit", () => {
  assert.throws(() => validateEnvelope({ ...envelope, cookie: "no" }), /INVALID_DECISION_ENVELOPE/);
  assert.throws(() => validateEnvelope({ ...envelope, candidate_commit: "wrong" }), /INVALID_CANDIDATE_COMMIT/);
});

test("one click can select the latest exact Decision code block without manual text selection", () => {
  const result = parseDecisionCandidates(["not json", JSON.stringify({ ...envelope, cookie: "reject" }), `\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\``]);
  assert.deepEqual(result, envelope);
});

test("content-script trusted DOM click forwards the latest Decision block with zero selection", async () => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/content.js"), "utf8");
  let clickHandler; let sent;
  const button = { style: {}, addEventListener(type, handler) { if (type === "click") clickHandler = handler; } };
  const staleBlock = { textContent: JSON.stringify({ ...envelope, issue_id: "FILMOS-ISSUE-stale" }) };
  const currentBlock = { textContent: JSON.stringify(envelope) };
  const staleReply = { querySelectorAll: () => [staleBlock] };
  const currentReply = { querySelectorAll: () => [currentBlock] };
  const context = {
    document: { getElementById: () => null, createElement: () => button, querySelectorAll: (selector) => selector.includes("article") ? [staleReply, currentReply] : [staleBlock, currentBlock], documentElement: { append() {} } },
    window: { getSelection: () => ({ toString: () => "" }) },
    navigator: { userActivation: { isActive: true } },
    chrome: { runtime: { async sendMessage(message) { sent = message; return { ok: true, ack: { issue_id: envelope.issue_id } }; } } },
    setTimeout() {}, JSON, Date, Object, Set, Error,
  };
  vm.runInNewContext(source, context);
  assert.equal(button.style.bottom, "96px");
  await clickHandler({ isTrusted: true });
  assert.equal(sent.type, "FILMOS_REVIEW_WRITEBACK");
  assert.equal(sent.candidateTexts.length, 1);
  assert.deepEqual(JSON.parse(sent.candidateTexts[0]), envelope);
});
