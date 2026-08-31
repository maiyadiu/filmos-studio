(() => {
  if (document.getElementById("filmos-review-send")) return;
  const button = document.createElement("button");
  button.id = "filmos-review-send";
  button.type = "button";
  button.textContent = "发送到 FilmOS";
  Object.assign(button.style, { position: "fixed", right: "24px", bottom: "180px", zIndex: "2147483647", padding: "10px 14px", borderRadius: "10px", border: "1px solid #777", background: "#111", color: "#fff", cursor: "pointer" });
  button.addEventListener("click", async (event) => {
    if (!event.isTrusted || !navigator.userActivation?.isActive) return show("需要用户点击");
    try {
      const selectionState = window.getSelection();
      const assistantMessages = [...document.querySelectorAll('main [data-message-author-role="assistant"], [data-message-author-role="assistant"]')];
      const latestAssistant = assistantMessages.at(-1);
      const replies = [...document.querySelectorAll("main article, article")];
      const latestReply = latestAssistant?.closest?.("article") ?? latestAssistant ?? replies.at(-1);
      const blocks = latestReply
        ? [...latestReply.querySelectorAll("pre")].reverse().map((node) => node.textContent?.trim()).filter(Boolean)
        : [...document.querySelectorAll("main pre, pre")].slice(-1).map((node) => node.textContent?.trim()).filter(Boolean);
      const replyText = latestReply?.textContent?.trim();
      const selectionText = selectionState?.toString().trim();
      const selectionNode = selectionState?.anchorNode;
      const selection = selectionText && selectionNode && latestReply?.contains?.(selectionNode) ? selectionText : "";
      const candidateTexts = [...new Set([...blocks, replyText, selection].filter(Boolean))];
      if (!candidateTexts.length) throw new Error("当前 ChatGPT 回复中没有结构化 FilmOS Decision");
      const response = await chrome.runtime.sendMessage({ type: "FILMOS_REVIEW_WRITEBACK", userGestureAt: Date.now(), candidateTexts });
      if (!response?.ok) throw new Error(response?.code ?? "FilmOS 未确认接收");
      show(`已发送：${response.ack.issue_id}`);
    } catch (error) { show(error.message); }
  });
  document.documentElement.append(button);
  function show(text) { button.textContent = text; setTimeout(() => { button.textContent = "发送到 FilmOS"; }, 4_000); }
})();
