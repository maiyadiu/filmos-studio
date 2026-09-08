import { useEffect, useMemo, useRef } from "react";
import { useUserStore } from "@/stores/use-user-store";
import { LocalRuntimeSessionClient } from "@/services/local-runtime-session";
import { issueRuntimeAccountProof } from "@/services/api/auth";
import { AgentSessionClient } from "./agent-client";
import { RuntimeAccountClient } from "./runtime-account-client";

// Non-chat entry points own a private, lazy connection too. Never borrow the
// canvas panel's transport or reactivate an unmounted account via a late action.
export function useAccountAgentClient() {
    const userId = useUserStore(state => state.user?.id ?? "");
    const binding = useRef<{ userId: string; runtime: RuntimeAccountClient } | undefined>(undefined);
    useEffect(() => {
        const runtime = new RuntimeAccountClient({ userId, origin: globalThis.location?.origin ?? "",
            runtime: () => new LocalRuntimeSessionClient(), issueProof: issueRuntimeAccountProof });
        const current = { userId, runtime };
        binding.current = current;
        return () => {
            if (binding.current === current) binding.current = undefined;
            void runtime.disconnect().catch(() => undefined);
        };
    }, [userId]);
    return useMemo(() => new AgentSessionClient({ async request(path, init = {}) {
        const current = binding.current;
        if (!current || current.userId !== userId) throw new DOMException("aborted", "AbortError");
        await current.runtime.connect(init.signal ?? undefined);
        if (binding.current !== current) throw new DOMException("aborted", "AbortError");
        return current.runtime.request(path, init);
    } }), [userId]);
}
