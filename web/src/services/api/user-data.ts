import type { Asset } from "@/stores/use-asset-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { apiClient, request } from "@/services/api/request";

const api = apiClient;

export type RemoteUserDataSummary = {
    id: string;
    kind?: string;
    title: string;
    createdAt: string;
    updatedAt: string;
};

export type RemoteUserDataSnapshot = {
    assets: Asset[];
    projects: CanvasProject[];
    projectContentHashes: Record<string, string>;
};

export function getRemoteUserDataSnapshot() {
    return request<RemoteUserDataSnapshot>(api.get("/user-data/snapshot"));
}

export function listRemoteAssets() {
    return request<{ assets: RemoteUserDataSummary[] }>(api.get("/assets"));
}

export function getRemoteAsset(id: string) {
    return request<{ asset: Asset }>(api.get(`/assets/${encodeURIComponent(id)}`));
}

export function upsertRemoteAsset(asset: Asset) {
    return request<{ asset: RemoteUserDataSummary }>(api.put(`/assets/${encodeURIComponent(asset.id)}`, { asset }));
}

export function deleteRemoteAsset(id: string) {
    return request<{ id: string }>(api.delete(`/assets/${encodeURIComponent(id)}`));
}

export function listRemoteCanvasProjects() {
    return request<{ projects: RemoteUserDataSummary[] }>(api.get("/canvas-projects"));
}

export function getRemoteCanvasProject(id: string, signal?: AbortSignal) {
    return request<{ project: CanvasProject; contentHash: string }>(api.get(`/canvas-projects/${encodeURIComponent(id)}`, { signal }));
}

export function upsertRemoteCanvasProject(project: CanvasProject, expectedContentHash?: string) {
    return request<{ project: RemoteUserDataSummary & { contentHash: string } }>(api.put(`/canvas-projects/${encodeURIComponent(project.id)}`, { project, ...(expectedContentHash !== undefined ? { expectedContentHash } : {}) }));
}

export function deleteRemoteCanvasProject(id: string) {
    return request<{ id: string }>(api.delete(`/canvas-projects/${encodeURIComponent(id)}`));
}
