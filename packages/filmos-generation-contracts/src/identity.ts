import type { PseudonymousBindingRef } from "./types.js";

export function createPseudonymousBindingRef(prefix: "acct" | "instance" = "instance"): PseudonymousBindingRef {
    return `filmos_${prefix}_${crypto.randomUUID()}`;
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
