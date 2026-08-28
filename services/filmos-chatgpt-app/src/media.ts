import type { ProjectGrant } from "./grants.js";

export type MediaProxyObject = { project_id: string; content_type: "image/jpeg" | "image/png" | "video/mp4"; bytes: Uint8Array; width?: number; height?: number; is_proxy: true };
export interface MediaProxyStore { get(id: string): Promise<MediaProxyObject | null> }

export class EmptyMediaProxyStore implements MediaProxyStore {
  async get(): Promise<null> { return null; }
}

export async function authorizeMediaProxy(store: MediaProxyStore, grant: ProjectGrant, id: string): Promise<MediaProxyObject> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new MediaProxyError("INVALID_MEDIA_ID", 400);
  const object = await store.get(id);
  if (!object) throw new MediaProxyError("MEDIA_PROXY_UNAVAILABLE", 404);
  if (object.project_id !== grant.project_id) throw new MediaProxyError("PROJECT_SCOPE_DENIED", 403);
  if (!object.is_proxy || object.bytes.byteLength > 8 * 1024 * 1024 || (object.width ?? 0) > 2048 || (object.height ?? 0) > 2048) {
    throw new MediaProxyError("RAW_MEDIA_DENIED", 403);
  }
  return object;
}

export class MediaProxyError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}
