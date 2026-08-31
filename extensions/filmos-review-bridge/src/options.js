const token = document.querySelector("#token");
const status = document.querySelector("#status");
document.querySelector("#save").addEventListener("click", async (event) => { if (!event.isTrusted || token.value.length < 24) return status.textContent = "密钥无效"; await chrome.storage.local.set({ bridgeToken: token.value }); token.value = ""; status.textContent = "已配对"; });
document.querySelector("#revoke").addEventListener("click", async (event) => { if (!event.isTrusted) return; const response = await chrome.runtime.sendMessage({ type: "FILMOS_REVIEW_REVOKE" }); status.textContent = response?.ok ? "已撤销" : response?.code ?? "撤销失败"; });

