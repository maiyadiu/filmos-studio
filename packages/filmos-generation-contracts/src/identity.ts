import type { PseudonymousBindingRef } from "./types.js";

export function createPseudonymousBindingRef(prefix: "acct" | "instance" = "instance"): PseudonymousBindingRef {
    return `filmos_${prefix}_${crypto.randomUUID()}`;
}

export async function createLocalHmacBindingRef(input: {
    secret: Uint8Array;
    namespace: string;
    sourceBinding: string;
    subtle?: SubtleCrypto;
}): Promise<PseudonymousBindingRef> {
    if (!(input.secret instanceof Uint8Array) || input.secret.byteLength < 32) throw new Error("LOCAL_BINDING_HMAC_SECRET_INVALID");
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(input.namespace) || !input.sourceBinding || input.sourceBinding.length > 512) {
        throw new Error("LOCAL_BINDING_HMAC_INPUT_INVALID");
    }
    const subtle = input.subtle ?? crypto.subtle;
    const secret = Uint8Array.from(input.secret).buffer;
    const key = await subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = new Uint8Array(await subtle.sign("HMAC", key, new TextEncoder().encode(`${input.namespace}\0${input.sourceBinding}`)));
    const bytes = digest.slice(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    return assertPseudonymousBindingRef(`filmos_acct_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
}

export function assertPseudonymousBindingRef(value: string): PseudonymousBindingRef {
    if (!/^filmos_(acct|instance)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
        throw new Error("PSEUDONYMOUS_BINDING_REF_INVALID");
    }
    return value;
}

export function assertConnectionBinding(input: { authScope: string; accountBindingRef?: string; connectionInstanceRef?: string }): void {
    if (!input.connectionInstanceRef) throw new Error("CONNECTION_INSTANCE_REF_REQUIRED");
    assertPseudonymousBindingRef(input.connectionInstanceRef);
    if (input.authScope === "account" && !input.accountBindingRef) throw new Error("ACCOUNT_BINDING_REF_REQUIRED");
    if (input.accountBindingRef) assertPseudonymousBindingRef(input.accountBindingRef);
}
