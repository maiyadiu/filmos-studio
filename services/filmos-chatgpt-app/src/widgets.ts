import { WIDGET_RUNTIME_JS } from "./generated-widget-runtime.js";

export const WIDGETS: Record<string, { title: string; description: string; html: string }> = Object.fromEntries(
  [
    ["ui://filmos/project-overview-v1.html", "Project Overview", "Read-only overview of the authorized FilmOS project.", "project"],
    ["ui://filmos/content-unit-progress-v1.html", "ContentUnit Progress", "Formal-state progress for one authorized ContentUnit.", "content-unit"],
    ["ui://filmos/shot-review-v1.html", "Shot Review", "Read-only Shot review card; no approval action.", "shot"],
    ["ui://filmos/asset-version-v1.html", "Asset Version", "Safe metadata and proxy availability for one asset version.", "asset"],
    ["ui://filmos/scene-twin-v1.html", "SceneTwin", "Read-only spatial anchors, zones, and fixed props.", "scene-twin"],
    ["ui://filmos/review-queue-v1.html", "Review Queue", "Candidate and Review Draft items awaiting human action in FilmOS.", "review-queue"],
    ["ui://filmos/proposal-export-v1.html", "Proposal Export", "Prepare a local proposal handoff without applying it to FilmOS.", "proposal-export"],
  ].map(([uri, title, description, kind]) => [uri, { title, description, html: widgetHtml(title, kind) }]),
);

function widgetHtml(title: string, kind: string): string {
  const safeTitle = title.replace(/[<>&]/g, "");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    :root{font:14px/1.45 Inter,system-ui,sans-serif;color:#171717;background:transparent;color-scheme:light dark}
    *{box-sizing:border-box}body{margin:0;padding:12px}.card{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:14px;padding:16px;background:color-mix(in srgb,Canvas 96%,currentColor 4%)}
    header{display:flex;justify-content:space-between;gap:12px;align-items:center}h1{font-size:16px;margin:0}.badge{font-size:11px;padding:3px 7px;border-radius:999px;background:#7456d81d;color:#7456d8}.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px}.stat{padding:10px;border-radius:10px;background:color-mix(in srgb,currentColor 6%,transparent)}.stat strong,.stat span{display:block}.stat span{font-size:11px;opacity:.65}ul{padding-left:18px}button{margin-top:12px;border:0;border-radius:9px;padding:8px 11px;background:#7456d8;color:white;cursor:pointer}button[hidden],p[hidden]{display:none}.warning{color:#b05b00;font-size:12px}
  </style>
</head>
<body data-widget="${kind}"><main class="card"><header><h1 id="headline">${safeTitle}</h1><span class="badge">READ ONLY</span></header><p id="warning" class="warning" hidden></p><section id="stats" class="stats"></section><ul id="details"><li>Waiting for an MCP tool result.</li></ul><button id="download" hidden>Download .filmosproposal</button></main>
<script>${WIDGET_RUNTIME_JS}</script></body></html>`;
}
