export const WIDGETS: Record<string, { title: string; description: string; html: string }> = Object.fromEntries(
  [
    ["ui://filmos/project-overview-v1.html", "Project Overview", "Read-only overview of the authorized FilmOS project."],
    ["ui://filmos/content-unit-progress-v1.html", "ContentUnit Progress", "Formal-state progress for one authorized ContentUnit."],
    ["ui://filmos/shot-review-v1.html", "Shot Review", "Read-only Shot review card; no approval action."],
    ["ui://filmos/asset-version-v1.html", "Asset Version", "Safe metadata and proxy availability for one asset version."],
    ["ui://filmos/scene-twin-v1.html", "SceneTwin", "Read-only spatial anchors, zones, and fixed props."],
    ["ui://filmos/review-queue-v1.html", "Review Queue", "Candidate and Review Draft items awaiting human action in FilmOS."],
    ["ui://filmos/proposal-export-v1.html", "Proposal Export", "Prepare a local proposal handoff without applying it to FilmOS."],
  ].map(([uri, title, description]) => [uri, { title, description, html: widgetHtml(title) }]),
);

function widgetHtml(title: string): string {
  const safeTitle = title.replace(/[<>&]/g, "");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    :root{font:14px/1.45 Inter,system-ui,sans-serif;color:#171717;background:transparent;color-scheme:light dark}
    *{box-sizing:border-box}body{margin:0;padding:12px}.card{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:14px;padding:16px;background:color-mix(in srgb,Canvas 96%,currentColor 4%)}
    header{display:flex;justify-content:space-between;gap:12px;align-items:center}h1{font-size:16px;margin:0}.badge{font-size:11px;padding:3px 7px;border-radius:999px;background:#7456d81d;color:#7456d8}
    pre{white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto;margin:12px 0 0;font:12px/1.45 ui-monospace,monospace}button{margin-top:12px;border:0;border-radius:9px;padding:8px 11px;background:#7456d8;color:white;cursor:pointer}button[hidden]{display:none}.muted{opacity:.7;font-size:12px}
  </style>
</head>
<body><main class="card"><header><h1>${safeTitle}</h1><span class="badge">READ ONLY</span></header><p class="muted" id="status">Waiting for an MCP tool result.</p><pre id="data">{}</pre><button id="download" hidden>Download .filmosproposal</button></main>
<script type="module">
  const data = document.querySelector('#data'); const status = document.querySelector('#status'); const download = document.querySelector('#download');
  const render = (payload) => { const value = payload?.structuredContent ?? payload ?? {}; data.textContent = JSON.stringify(value, null, 2); status.textContent = value.security_warnings?.length ? 'Untrusted project instructions were ignored.' : 'Authorized FilmOS snapshot'; const pkg = value.package; download.hidden = !pkg; download.onclick = () => { const blob = new Blob([JSON.stringify(pkg, null, 2)], {type:'application/vnd.filmos.proposal+json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=(pkg.proposal_id || 'proposal')+'.filmosproposal'; a.click(); setTimeout(()=>URL.revokeObjectURL(url), 0); }; };
  window.addEventListener('message', (event) => { const message=event.data; if(message?.jsonrpc==='2.0' && message?.method==='ui/notifications/tool-result') render(message.params); });
  if (window.openai?.toolOutput) render(window.openai.toolOutput);
  window.parent.postMessage({jsonrpc:'2.0',id:'filmos-init',method:'ui/initialize',params:{appInfo:{name:'FilmOS',version:'1.0.0'},capabilities:{}}}, '*');
</script></body></html>`;
}
