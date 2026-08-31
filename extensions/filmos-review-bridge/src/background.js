import { parseDecisionCandidates, revokePairing, sendDecision } from "./protocol.mjs";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.url?.startsWith("https://chatgpt.com/")) return false;
  if (message?.type === "FILMOS_REVIEW_WRITEBACK") {
    chrome.storage.local.get(["bridgeSessionToken"]).then(({ bridgeSessionToken }) => sendDecision(parseDecisionCandidates(message.candidateTexts ?? []), { token: bridgeSessionToken, userGestureAt: message.userGestureAt }))
      .then((ack) => sendResponse({ ok: true, ack }))
      .catch((error) => sendResponse({ ok: false, code: error.message }));
    return true;
  }
  if (message?.type === "FILMOS_REVIEW_REVOKE") {
    chrome.storage.local.get(["bridgeSessionToken"]).then(({ bridgeSessionToken }) => revokePairing({ token: bridgeSessionToken }))
      .then(async (receipt) => { await chrome.storage.local.remove(["bridgeSessionToken", "bridgeClientId"]); sendResponse({ ok: true, receipt }); })
      .catch((error) => sendResponse({ ok: false, code: error.message }));
    return true;
  }
  return false;
});
