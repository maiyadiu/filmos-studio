import { App } from "@modelcontextprotocol/ext-apps";

import { buildWidgetModel, type WidgetKind } from "./widget-model.js";

declare global { interface Window { openai?: { toolOutput?: unknown } } }

const kind = document.body.dataset.widget as WidgetKind;
const headline = document.querySelector<HTMLElement>("#headline")!;
const stats = document.querySelector<HTMLElement>("#stats")!;
const details = document.querySelector<HTMLElement>("#details")!;
const warning = document.querySelector<HTMLElement>("#warning")!;
const download = document.querySelector<HTMLButtonElement>("#download")!;

function render(payload: unknown) {
  const model = buildWidgetModel(kind, payload);
  headline.textContent = model.headline;
  stats.replaceChildren(...model.stats.map((item) => {
    const node = document.createElement("div"); node.className = "stat";
    const value = document.createElement("strong"); value.textContent = item.value;
    const label = document.createElement("span"); label.textContent = item.label;
    node.append(value, label); return node;
  }));
  details.replaceChildren(...model.details.map((item) => { const li = document.createElement("li"); li.textContent = item; return li; }));
  warning.textContent = model.warning ?? ""; warning.hidden = !model.warning;
  download.hidden = !model.proposal;
  download.onclick = model.proposal ? () => {
    const proposal = model.proposal as { proposal_id?: string };
    const blob = new Blob([JSON.stringify(proposal, null, 2)], { type: "application/vnd.filmos.proposal+json" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${proposal.proposal_id ?? "proposal"}.filmosproposal`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } : null;
}

const app = new App({ name: "FilmOS", version: "1.0.0" }, {}, { autoResize: true, strict: true });
app.ontoolresult = (params) => render(params);
void (async () => {
  await app.connect();
  if (window.openai?.toolOutput) render(window.openai.toolOutput);
})();
