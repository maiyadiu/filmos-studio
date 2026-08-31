const baseUrl = "http://127.0.0.1:17920";
const purposes = new Set(["CHATGPT_ASSESSMENT", "CHATGPT_CONSENSUS_DECISION", "CHATGPT_REVIEW_DECISION", "CHATGPT_VERDICT", "FINDING_DECISION"]);

export async function pairBridge({ pairingCode, clientName = "Chrome FilmOS Review Bridge", fetchImpl = fetch }) {
  if (!/^\d{6}$/.test(String(pairingCode))) throw new Error("INVALID_PAIRING_CODE");
  const response = await fetchImpl(`${baseUrl}/v1/bridge/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: String(pairingCode), client_name: clientName }) });
  const body = await safeJson(response);
  if (!response.ok || typeof body.bridge_session_token !== "string" || !body.client_id) throw new Error(body.code ?? "PAIRING_FAILED");
  return body;
}

export function validateEnvelope(value) {
  const expected = ["purpose", "issue_id", "candidate_id", "candidate_commit", "decision"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\n") !== expected.sort().join("\n")) throw new Error("INVALID_DECISION_ENVELOPE");
  if (!purposes.has(value.purpose)) throw new Error("INVALID_DECISION_PURPOSE");
  if (!/^FILMOS-(?:ISSUE|ARCH)-[A-Za-z0-9-]{1,120}$/.test(value.issue_id)) throw new Error("INVALID_ISSUE_ID");
  if (value.candidate_id !== null && (typeof value.candidate_id !== "string" || !value.candidate_id)) throw new Error("INVALID_CANDIDATE_ID");
  if (value.candidate_commit !== null && !/^[0-9a-f]{40,64}$/.test(value.candidate_commit)) throw new Error("INVALID_CANDIDATE_COMMIT");
  return structuredClone(value);
}

export function parseDecisionCandidates(texts) {
  for (const text of texts) {
    try {
      const parsed = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
      return validateEnvelope(parsed);
    } catch { /* Continue until one exact, candidate-bound Decision is found. */ }
  }
  throw new Error("NO_VALID_FILMOS_DECISION_FOUND");
}

export async function sendDecision(envelope, { token, userGestureAt, fetchImpl = fetch, now = Date.now() }) {
  const value = validateEnvelope(envelope);
  if (!Number.isFinite(userGestureAt) || now - userGestureAt > 5_000 || userGestureAt > now + 1_000) throw new Error("CHROME_USER_GESTURE_REQUIRED");
  if (typeof token !== "string" || token.length < 24) throw new Error("BRIDGE_NOT_PAIRED");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-filmos-user-gesture": "1" };
  const challengeResponse = await fetchImpl(`${baseUrl}/v1/bridge/challenge`, { method: "POST", headers, body: JSON.stringify({ purpose: value.purpose, issue_id: value.issue_id, candidate_id: value.candidate_id, candidate_commit: value.candidate_commit }) });
  const challenge = await safeJson(challengeResponse);
  if (!challengeResponse.ok) throw new Error(challenge.code ?? "CHALLENGE_FAILED");
  const decisionResponse = await fetchImpl(`${baseUrl}/v1/bridge/decision`, { method: "POST", headers, body: JSON.stringify({ challenge_id: challenge.challenge_id, nonce: challenge.nonce, ...value }) });
  const ack = await safeJson(decisionResponse);
  if (!decisionResponse.ok || ack.ack !== true) throw new Error(ack.code ?? "WRITEBACK_FAILED");
  return ack;
}

export async function revokePairing({ token, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl}/v1/bridge/revoke`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-filmos-user-gesture": "1" }, body: "{}" });
  const body = await safeJson(response);
  if (!response.ok) throw new Error(body.code ?? "PAIRING_REVOKE_FAILED");
  return body;
}

async function safeJson(response) { try { return await response.json(); } catch { return { code: "BRIDGE_OFFLINE_OR_INVALID_RESPONSE" }; } }
