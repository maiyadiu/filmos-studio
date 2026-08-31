import { createLocalHmacBindingRef, type PseudonymousBindingRef } from "@filmos/generation-contracts";
import localforage from "localforage";

const SECRET_KEY = "generation-account-binding-hmac-v1";
const secretStore = localforage.createInstance({
    name: "filmos-local-secrets",
    storeName: "generation_binding_hmac",
});

export type LocalAccountBindingRefResolver = (engineId: string, sourceBinding: string) => Promise<PseudonymousBindingRef>;

export function createLocalAccountBindingRefResolver(loadSecret: () => Promise<Uint8Array>): LocalAccountBindingRefResolver {
    return async (engineId, sourceBinding) => createLocalHmacBindingRef({
        secret: await loadSecret(),
        namespace: `generation-engine:${engineId}`,
        sourceBinding,
    });
}

export const localAccountBindingRef = createLocalAccountBindingRefResolver(loadOrCreateLocalSecret);

async function loadOrCreateLocalSecret(): Promise<Uint8Array> {
    const stored = await secretStore.getItem<string>(SECRET_KEY);
    if (stored) return decode(stored);
    const generated = crypto.getRandomValues(new Uint8Array(32));
    await secretStore.setItem(SECRET_KEY, encode(generated));
    return generated;
}

function encode(value: Uint8Array): string {
    return btoa(String.fromCharCode(...value));
}

function decode(value: string): Uint8Array {
    const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (decoded.byteLength !== 32) throw new Error("LOCAL_BINDING_HMAC_SECRET_INVALID");
    return decoded;
}
