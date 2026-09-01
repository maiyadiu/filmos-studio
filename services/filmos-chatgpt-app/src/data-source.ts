import type { ProjectGrant } from "./grants.js";
import { sha256 } from "./canonical.js";
import { assertLoopbackUrl, assertSafeIdentifier, detectUntrustedInstructions, sanitizeForMcp, SecurityBoundaryError } from "./security.js";

export type ToolPayload = {
  uri: string;
  version: number;
  state_hash: string;
  project_id: string;
  kind: string;
  data: unknown;
  security_warnings: string[];
};

export interface FilmOSReadDataSource {
  read(name: string, input: Record<string, unknown>, grant: ProjectGrant, signal?: AbortSignal): Promise<ToolPayload>;
  search(query: string, grant: ProjectGrant, signal?: AbortSignal): Promise<Array<{ id: string; title: string; url: string }>>;
  fetch(id: string, grant: ProjectGrant, signal?: AbortSignal): Promise<{ id: string; title: string; text: string; url: string; metadata?: Record<string, unknown> }>;
}

export class FilmCoreReadClient implements FilmOSReadDataSource {
  private readonly baseUrl: URL;

  constructor(baseUrl = "http://127.0.0.1:17650/film") {
    this.baseUrl = assertLoopbackUrl(baseUrl, "Film Core URL");
  }

  async read(name: string, input: Record<string, unknown>, grant: ProjectGrant, signal?: AbortSignal): Promise<ToolPayload> {
    const context = await this.getJson(`/projects/${encodeURIComponent(grant.project_id)}/context`, signal);
    const value = await this.resolve(name, input, grant, context, signal);
    return envelope(name, grant.project_id, value);
  }

  async search(query: string, grant: ProjectGrant, signal?: AbortSignal) {
    const context = await this.getJson(`/projects/${encodeURIComponent(grant.project_id)}/context`, signal) as Record<string, unknown>;
    const needle = query.toLocaleLowerCase();
    return searchableDocuments(context, grant.project_id)
      .filter((item) => `${item.title}\n${item.text}`.toLocaleLowerCase().includes(needle))
      .map(({ id, title, url }) => ({ id, title, url }));
  }

  async fetch(id: string, grant: ProjectGrant, signal?: AbortSignal) {
    const safeId = assertSafeIdentifier(id, "id");
    if (!safeId.startsWith(`filmos://project/${grant.project_id}/`)) throw new SecurityBoundaryError("project_scope_denied", "Requested URI is outside the Project Grant");
    const context = await this.getJson(`/projects/${encodeURIComponent(grant.project_id)}/context`, signal) as Record<string, unknown>;
    const item = searchableDocuments(context, grant.project_id).find((candidate) => candidate.id === safeId);
    if (!item) throw new SecurityBoundaryError("not_found", "Authorized FilmOS object was not found");
    return { ...item, metadata: { project_id: grant.project_id, state_hash: sha256(item.text) } };
  }

  private async resolve(name: string, input: Record<string, unknown>, grant: ProjectGrant, context: unknown, signal?: AbortSignal): Promise<unknown> {
    switch (normalizeRenderName(name)) {
      case "filmos_get_project_context":
        return context;
      case "filmos_get_content_unit_context": {
        const id = assertSafeIdentifier(input.host_unit_id, "host_unit_id");
        const unit = await this.getJson(`/units/${encodeURIComponent(id)}`, signal);
        assertHostProject(unit, grant.project_id);
        return unit;
      }
      case "filmos_get_shot_context": {
        const id = assertSafeIdentifier(input.host_shot_id, "host_shot_id");
        const shot = await this.getJson(`/shots/${encodeURIComponent(id)}`, signal);
        assertHostProject(shot, grant.project_id);
        return shot;
      }
      case "filmos_get_asset_version":
      case "filmos_get_scene_twin_summary":
      case "filmos_get_continuity_report": {
        const id = assertSafeIdentifier(input.film_entity_id, "film_entity_id");
        const path = name.includes("scene_twin") ? `/spatial-versions/${encodeURIComponent(id)}` : `/formal-records/${encodeURIComponent(id)}`;
        const value = await this.getJson(path, signal);
        assertEntityProject(value, context, grant.project_id);
        return value;
      }
      case "filmos_get_generation_attempts":
        return { items: await this.formalRecordsFromAudit(["generation_attempt_evidence.created", "candidate.created"], context, grant.project_id, signal), completeness: "FILM_CORE_AUDIT_INDEX" };
      case "filmos_get_review_queue": {
        const records = await this.formalRecordsFromAudit(["candidate.created", "review.created"], context, grant.project_id, signal);
        return { items: records.map(reviewQueueItem), completeness: "FILM_CORE_AUDIT_INDEX", allowed_states: ["Candidate", "Review Draft"] };
      }
      case "filmos_get_blockers":
        return deriveBlockerReport(context, grant.project_id);
      case "filmos_get_recent_changes": {
        const limit = boundedLimit(input.limit);
        const targetIds = [...contextEntityIds(context)].slice(0, 25);
        const results = await Promise.all(targetIds.map((id) => this.getJson(`/audit-events?targetId=${encodeURIComponent(id)}&limit=${limit}`, signal).catch(() => [])));
        return { items: results.flat().slice(0, limit), completeness: "PROJECT_CONTEXT_ENTITY_TARGETS" };
      }
      default:
        throw new SecurityBoundaryError("unknown_tool", `Unsupported read tool: ${name}`);
    }
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<any> {
    const url = new URL(`${this.baseUrl.pathname.replace(/\/$/, "")}${path}`, this.baseUrl);
    const response = await fetch(url, { headers: { accept: "application/json" }, signal });
    if (!response.ok) throw new Error(`Film Core read failed: ${response.status}`);
    return response.json();
  }

  private async formalRecordsFromAudit(actions: string[], context: unknown, projectId: string, signal?: AbortSignal): Promise<unknown[]> {
    const events = await this.getJson("/audit-events?limit=500", signal) as Array<{ action?: unknown; target_id?: unknown }>;
    const targetIds = [...new Set(events.filter((event) => actions.includes(String(event.action))).map((event) => String(event.target_id ?? "")).filter(Boolean))];
    const records: unknown[] = [];
    for (const targetId of targetIds) {
      try {
        const record = await this.getJson(`/formal-records/${encodeURIComponent(assertSafeIdentifier(targetId, "target_id"))}`, signal);
        if (record?.ref?.entity_type === "review" && record?.target_id) {
          const candidate = await this.getJson(`/formal-records/${encodeURIComponent(assertSafeIdentifier(record.target_id, "candidate_id"))}`, signal);
          assertEntityProject(candidate, context, projectId);
        } else if (record?.ref?.entity_type === "generation_attempt_evidence" && record?.generation_package_id) {
          const generationPackage = await this.getJson(`/formal-records/${encodeURIComponent(assertSafeIdentifier(record.generation_package_id, "generation_package_id"))}`, signal);
          assertEntityProject(generationPackage, context, projectId);
        } else {
          assertEntityProject(record, context, projectId);
        }
        records.push(record);
      } catch (error) {
        if (!(error instanceof SecurityBoundaryError)) continue;
      }
    }
    return records;
  }
}

export class MemoryFilmOSReadDataSource implements FilmOSReadDataSource {
  constructor(private readonly projects: Record<string, Record<string, unknown>>) {}

  async read(name: string, input: Record<string, unknown>, grant: ProjectGrant): Promise<ToolPayload> {
    const project = this.projects[grant.project_id];
    if (!project) throw new SecurityBoundaryError("project_scope_denied", "Project Grant has no matching project");
    const normalized = normalizeRenderName(name);
    let value: unknown = project;
    if (normalized.includes("content_unit")) value = findHost(project.content_units, "host_unit_id", assertSafeIdentifier(input.host_unit_id, "host_unit_id"));
    else if (normalized.includes("shot")) value = findHost(project.shots, "host_shot_id", assertSafeIdentifier(input.host_shot_id, "host_shot_id"));
    else if (normalized.includes("asset")) value = findRef(project.assets, assertSafeIdentifier(input.film_entity_id, "film_entity_id"));
    else if (normalized.includes("scene_twin")) value = findRef(project.scene_twins, assertSafeIdentifier(input.film_entity_id, "film_entity_id"));
    else if (normalized.includes("continuity")) value = findRef(project.continuity_reports, assertSafeIdentifier(input.film_entity_id, "film_entity_id"));
    else if (normalized.includes("generation_attempts")) value = { items: project.generation_attempts ?? [] };
    else if (normalized.includes("review_queue")) value = { items: project.review_queue ?? [] };
    else if (normalized.includes("blockers")) value = { items: project.blockers ?? [] };
    else if (normalized.includes("recent_changes")) value = { items: (project.recent_changes as unknown[] ?? []).slice(0, boundedLimit(input.limit)) };
    return envelope(name, grant.project_id, value);
  }

  async search(query: string, grant: ProjectGrant) {
    const project = this.projects[grant.project_id];
    if (!project) return [];
    const needle = query.toLocaleLowerCase();
    return searchableDocuments(project, grant.project_id).filter((item) => `${item.title}\n${item.text}`.toLocaleLowerCase().includes(needle)).map(({ id, title, url }) => ({ id, title, url }));
  }

  async fetch(id: string, grant: ProjectGrant) {
    if (!id.startsWith(`filmos://project/${grant.project_id}/`)) throw new SecurityBoundaryError("project_scope_denied", "Requested URI is outside the Project Grant");
    const project = this.projects[grant.project_id];
    const item = project && searchableDocuments(project, grant.project_id).find((candidate) => candidate.id === id);
    if (!item) throw new SecurityBoundaryError("not_found", "Authorized FilmOS object was not found");
    return { ...item, metadata: { project_id: grant.project_id, state_hash: sha256(item.text) } };
  }
}

function envelope(kind: string, projectId: string, value: unknown): ToolPayload {
  const sanitized = sanitizeForMcp(value);
  return {
    uri: `filmos://project/${projectId}/${kind.replace(/^filmos_(?:get|render)_/, "").replaceAll("_", "/")}`,
    version: extractVersion(sanitized),
    state_hash: sha256(sanitized),
    project_id: projectId,
    kind,
    data: sanitized,
    security_warnings: detectUntrustedInstructions(value),
  };
}

function normalizeRenderName(name: string): string {
  return name.replace("filmos_render_project_overview", "filmos_get_project_context")
    .replace("filmos_render_content_unit_progress", "filmos_get_content_unit_context")
    .replace("filmos_render_shot_review", "filmos_get_shot_context")
    .replace("filmos_render_asset_version", "filmos_get_asset_version")
    .replace("filmos_render_scene_twin", "filmos_get_scene_twin_summary")
    .replace("filmos_render_review_queue", "filmos_get_review_queue");
}

function extractVersion(value: any): number {
  return Number(value?.ref?.version ?? value?.film_project?.ref?.version ?? 1);
}

function contextEntityIds(context: any): Set<string> {
  const entities = [context?.film_project, ...(context?.content_units ?? []), ...(context?.shots ?? [])];
  const ids = entities.flatMap((item: any) => item?.ref?.film_entity_id ? [String(item.ref.film_entity_id)] : []);
  for (const shot of context?.shots ?? []) for (const id of shot?.director_unit_ids ?? []) ids.push(String(id));
  return new Set(ids);
}

function assertHostProject(value: any, projectId: string): void {
  if (value?.host?.host_project_id !== projectId) throw new SecurityBoundaryError("project_scope_denied", "Entity is outside the Project Grant");
}

function assertEntityProject(value: any, context: any, projectId: string): void {
  if (value?.host?.host_project_id === projectId || value?.host_project_id === projectId) return;
  const allowedIds = contextEntityIds(context);
  const projectEntityId = context?.film_project?.ref?.film_entity_id;
  if (projectEntityId) allowedIds.add(String(projectEntityId));
  const references = collectFilmEntityIds(value);
  if ([...references].some((id) => allowedIds.has(id))) return;
  throw new SecurityBoundaryError("project_scope_denied", "Entity is outside the Project Grant");
}

function collectFilmEntityIds(value: unknown, seen = new Set<unknown>()): Set<string> {
  const ids = new Set<string>();
  if (!value || typeof value !== "object" || seen.has(value)) return ids;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) for (const id of collectFilmEntityIds(item, seen)) ids.add(id);
    return ids;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "film_entity_id" && typeof item === "string") ids.add(item);
    else for (const id of collectFilmEntityIds(item, seen)) ids.add(id);
  }
  return ids;
}

function searchableDocuments(context: Record<string, unknown>, projectId: string) {
  const candidates: Array<{ kind: string; key: string; value: unknown; title: string }> = [
    { kind: "context", key: "project", value: context, title: `FilmOS project ${projectId}` },
  ];
  for (const [key, singular] of [["content_units", "unit"], ["shots", "shot"], ["assets", "asset"], ["scene_twins", "scene-twin"]] as const) {
    for (const [index, value] of ((context[key] as unknown[]) ?? []).entries()) {
      const hostKey = singular === "unit" ? "host_unit_id" : singular === "shot" ? "host_shot_id" : "host_asset_id";
      const id = (value as any)?.host?.[hostKey] ?? (value as any)?.ref?.film_entity_id ?? index;
      candidates.push({ kind: singular, key: String(id), value, title: `${singular} ${id}` });
    }
  }
  return candidates.map((item) => {
    const url = `filmos://project/${projectId}/${item.kind}/${encodeURIComponent(item.key)}`;
    return { id: url, title: item.title, text: JSON.stringify(sanitizeForMcp(item.value)), url };
  });
}

export function deriveBlockerReport(context: any, projectId: string) {
  const contextProjectId = typeof context?.host_project_id === "string" ? context.host_project_id : null;
  if (contextProjectId !== projectId) throw new SecurityBoundaryError("project_scope_denied", "Blocker context is outside the Project Grant");
  const contentUnits = Array.isArray(context?.content_units) ? context.content_units : [];
  const shots = Array.isArray(context?.shots) ? context.shots : [];
  const entities = [context?.film_project, ...contentUnits, ...shots].filter(Boolean);
  const items: Array<Record<string, unknown>> = [];
  if (!context?.film_project) {
    items.push({
      blocker_id: `FILM_PROJECT_CONTEXT_NOT_PUBLISHED:${projectId}`,
      code: "FILM_PROJECT_CONTEXT_NOT_PUBLISHED",
      severity: "P0",
      project_id: projectId,
      entity_kind: "film_project_extension",
      entity_id: projectId,
      uri: `filmos://project/${projectId}/context/project`,
      message: "The current Domain Film Project has not been projected into Film Core.",
      evidence: { host_project_id: contextProjectId, film_project: null, content_unit_count: contentUnits.length, shot_count: shots.length },
    });
  }
  for (const item of entities) {
    const states = item?.states;
    const staleState = states?.stale_state;
    const executionState = states?.execution_state;
    if (staleState === "fresh" && executionState !== "failed") continue;
    const entityId = String(item?.ref?.film_entity_id ?? "unknown");
    const entityKind = String(item?.ref?.entity_type ?? "film_entity");
    const failed = executionState === "failed";
    const code = failed ? "ENTITY_EXECUTION_FAILED" : "ENTITY_STALE";
    items.push({
      blocker_id: `${code}:${entityId}`,
      code,
      severity: failed ? "P0" : "P1",
      project_id: projectId,
      entity_kind: entityKind,
      entity_id: entityId,
      uri: `filmos://project/${projectId}/entity/${encodeURIComponent(entityId)}`,
      message: failed ? "Film Core reports a failed execution state." : "Film Core reports a non-fresh entity state.",
      evidence: { stale_state: staleState ?? null, execution_state: executionState ?? null },
    });
  }
  return {
    project_id: projectId,
    items,
    completeness: "DERIVED_FROM_PROJECT_CONTEXT",
    project_scope: { requested_project_id: projectId, context_host_project_id: contextProjectId, exact_match: true },
    evaluation: { status: items.length ? "BLOCKED" : "CLEAR", blocker_count: items.length },
    evidence: { film_project_present: Boolean(context?.film_project), content_unit_count: contentUnits.length, shot_count: shots.length },
  };
}

function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(100, Math.max(1, value)) : 20;
}

function reviewQueueItem(value: any): unknown {
  const entityType = value?.ref?.entity_type;
  return { ...value, kind: entityType === "candidate" ? "Candidate" : entityType === "review" ? "Review" : "Unknown" };
}

function findHost(value: unknown, field: string, id: string): unknown {
  const result = ((value as unknown[]) ?? []).find((item: any) => item?.host?.[field] === id);
  if (!result) throw new SecurityBoundaryError("not_found", "Authorized FilmOS object was not found");
  return result;
}

function findRef(value: unknown, id: string): unknown {
  const result = ((value as unknown[]) ?? []).find((item: any) => item?.ref?.film_entity_id === id);
  if (!result) throw new SecurityBoundaryError("not_found", "Authorized FilmOS object was not found");
  return result;
}
