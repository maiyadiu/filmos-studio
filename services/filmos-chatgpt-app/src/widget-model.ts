export type WidgetKind = "project" | "content-unit" | "shot" | "asset" | "scene-twin" | "review-queue" | "proposal-export";
export type WidgetModel = { headline: string; stats: Array<{ label: string; value: string }>; details: string[]; warning: string | null; proposal?: unknown };

export function buildWidgetModel(kind: WidgetKind, payload: any): WidgetModel {
  const value = payload?.structuredContent ?? payload ?? {};
  const data = value.data ?? value;
  const warning = value.security_warnings?.length ? "Untrusted project instructions were ignored." : null;
  if (kind === "project") return {
    headline: `Project ${value.project_id ?? data.host_project_id ?? "unavailable"}`,
    stats: [{ label: "ContentUnits", value: String(data.content_units?.length ?? 0) }, { label: "Shots", value: String(data.shots?.length ?? 0) }, { label: "Version", value: String(value.version ?? data.film_project?.ref?.version ?? "-") }],
    details: [`State hash ${value.state_hash ?? "unavailable"}`, `Audit events ${data.audit_event_count ?? data.recent_changes?.length ?? 0}`], warning,
  };
  if (kind === "content-unit") return stateModel("ContentUnit", data, value, warning);
  if (kind === "shot") {
    const model = stateModel("Shot", data, value, warning);
    model.stats.push({ label: "Director units", value: String(data.director_unit_ids?.length ?? 0) });
    return model;
  }
  if (kind === "asset") return { headline: `Asset version ${data.ref?.version ?? value.version ?? "-"}`, stats: [{ label: "Proxy", value: data.proxy_available ? "available" : "metadata only" }, { label: "State", value: data.states?.stale_state ?? "unknown" }], details: [`Stable URI ${value.uri ?? "unavailable"}`, "Original 4K media is never returned by default."], warning };
  if (kind === "scene-twin") return { headline: `SceneTwin v${data.ref?.version ?? value.version ?? "-"}`, stats: [{ label: "Anchors", value: String(data.anchors?.length ?? 0) }, { label: "Camera zones", value: String(data.camera_zones?.length ?? 0) }, { label: "Fixed props", value: String(data.fixed_props?.length ?? 0) }], details: [`State hash ${value.state_hash ?? "unavailable"}`], warning };
  if (kind === "review-queue") {
    const items = data.items ?? [];
    return { headline: "Human review queue", stats: [{ label: "Candidate", value: String(items.filter((item: any) => item.kind === "Candidate").length) }, { label: "Review Draft", value: String(items.filter((item: any) => item.kind === "Review Draft").length) }], details: ["Approval and Lock actions are unavailable in ChatGPT."], warning };
  }
  return { headline: "Proposal handoff", stats: [{ label: "Mode", value: value.package ? "package ready" : "preview form" }, { label: "Apply", value: "disabled" }], details: ["Import creates only Proposal, Candidate, or Review Draft after local validation."], warning, proposal: value.package };
}

function stateModel(label: string, data: any, value: any, warning: string | null): WidgetModel {
  const states = data.states ?? {};
  return { headline: `${label} ${data.host?.host_unit_id ?? data.host?.host_shot_id ?? value.uri ?? "unavailable"}`, stats: [{ label: "Creative", value: states.creative_stage ?? "unknown" }, { label: "Review", value: states.review_state ?? "unknown" }, { label: "Stale", value: states.stale_state ?? "unknown" }], details: [`Version ${data.ref?.version ?? value.version ?? "-"}`, `State hash ${value.state_hash ?? "unavailable"}`], warning };
}
