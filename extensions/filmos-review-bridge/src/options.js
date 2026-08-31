import { pairBridge } from "./protocol.mjs";

const pairingCode = document.querySelector("#pairing-code");
const status = document.querySelector("#status");
document.querySelector("#pair").addEventListener("click", async (event) => {
  if (!event.isTrusted || !/^\d{6}$/.test(pairingCode.value)) return status.textContent = "请输入 FilmOS Review Center 显示的6位配对码";
  try {
    const paired = await pairBridge({ pairingCode: pairingCode.value });
    await chrome.storage.local.set({ bridgeSessionToken: paired.bridge_session_token, bridgeClientId: paired.client_id });
    pairingCode.value = "";
    status.textContent = `已配对：${paired.client_id}`;
  } catch (error) { status.textContent = error.message || "配对失败"; }
});
document.querySelector("#revoke").addEventListener("click", async (event) => { if (!event.isTrusted) return; const response = await chrome.runtime.sendMessage({ type: "FILMOS_REVIEW_REVOKE" }); status.textContent = response?.ok ? "已撤销" : response?.code ?? "撤销失败"; });
