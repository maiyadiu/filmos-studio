import { apiClient, request } from "@/services/api/request";

export type ProjectDirectoryLocation = {
    enabled: boolean;
    defaultParent?: string;
    selectedParent?: string;
    locationToken?: string;
    cancelled?: boolean;
};
export type LocalProjectDirectory = { requestId: string; locationToken?: string };
export type ProjectDirectoryStatus = { managed: boolean; path?: string; state: string; message?: string };
export const projectDirectoryHeaders = { "X-FilmOS-Project-Directory": "1", "Content-Type": "application/json" };

export function getProjectDirectoryLocation() {
    return request<ProjectDirectoryLocation>(apiClient.get("/project-locations"));
}
export function chooseProjectDirectory() {
    return request<ProjectDirectoryLocation>(apiClient.post("/project-locations/choose", {}, { headers: projectDirectoryHeaders, timeout: 125_000 }));
}
export function setDefaultProjectDirectory(locationToken: string) {
    return request<ProjectDirectoryLocation>(apiClient.put("/project-locations/default", { locationToken }, { headers: projectDirectoryHeaders }));
}
export function getProjectDirectoryStatus(projectId: string) {
    return request<ProjectDirectoryStatus>(apiClient.get(`/projects/${encodeURIComponent(projectId)}/directory`));
}
export function openProjectDirectory(projectId: string) {
    return request<{ opened: boolean }>(apiClient.post(`/projects/${encodeURIComponent(projectId)}/directory/open`, {}, { headers: projectDirectoryHeaders }));
}
export function syncProjectDirectory(projectId: string) {
    return request<ProjectDirectoryStatus>(apiClient.post(`/projects/${encodeURIComponent(projectId)}/directory/sync`, {}, { headers: projectDirectoryHeaders }));
}
export function relocateProjectDirectory(projectId: string) {
    return request<ProjectDirectoryStatus>(apiClient.post(`/projects/${encodeURIComponent(projectId)}/directory/relocate`, {}, { headers: projectDirectoryHeaders, timeout: 125_000 }));
}

export function exportProjectDirectory(projectId: string) {
    return request<{ path: string; sha256: string }>(apiClient.post(`/projects/${encodeURIComponent(projectId)}/directory/export`, {}, { headers: projectDirectoryHeaders, timeout: 120_000 }));
}
