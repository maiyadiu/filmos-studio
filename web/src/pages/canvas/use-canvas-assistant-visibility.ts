import { useCallback, useEffect, useRef, useState } from "react";

import { CANVAS_AGENT_PANEL_MOTION_MS } from "@/components/canvas/canvas-assistant-panel";
import type { CanvasAgentMode } from "@/components/canvas/canvas-agent-chat-ui";
import { normalizeBrainProfileId } from "@/film/agent/brain-profiles";

const ACTIVE_BRAIN_PROFILE_KEY = "filmos.agent.activeBrainProfileId";

export function readActiveBrainProfile(storage: Pick<Storage, "getItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage) {
    try {
        return normalizeBrainProfileId(storage?.getItem(ACTIVE_BRAIN_PROFILE_KEY));
    } catch {
        return "codex.subscription" as const;
    }
}

export function writeActiveBrainProfile(value: CanvasAgentMode, storage: Pick<Storage, "setItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage) {
    const profileId = normalizeBrainProfileId(value);
    try { storage?.setItem(ACTIVE_BRAIN_PROFILE_KEY, profileId); } catch { /* Preference persistence is best effort. */ }
    return profileId;
}

export function useCanvasAssistantVisibility() {
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [assistantCollapsed, setAssistantCollapsed] = useState(true);
    const [assistantMounted, setAssistantMounted] = useState(false);
    const [assistantClosing, setAssistantClosing] = useState(false);
    const [agentMode, setAgentModeState] = useState<CanvasAgentMode>(() => readActiveBrainProfile());

    const setAgentMode = useCallback((mode: CanvasAgentMode) => setAgentModeState(writeActiveBrainProfile(mode)), []);

    const openAgent = useCallback((mode?: CanvasAgentMode) => {
        if (closeTimerRef.current) {
            clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
        if (mode) setAgentModeState(writeActiveBrainProfile(mode));
        setAssistantMounted(true);
        setAssistantClosing(false);
        setAssistantCollapsed(false);
    }, []);

    const closeAgent = useCallback(() => {
        if (!assistantMounted || assistantClosing) return;
        setAssistantCollapsed(true);
        setAssistantClosing(true);
        closeTimerRef.current = setTimeout(() => {
            closeTimerRef.current = null;
            setAssistantMounted(false);
            setAssistantClosing(false);
        }, CANVAS_AGENT_PANEL_MOTION_MS);
    }, [assistantClosing, assistantMounted]);

    useEffect(() => () => {
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    }, []);

    return {
        agentMode,
        assistantClosing,
        assistantMounted,
        assistantOpen: assistantMounted && !assistantCollapsed,
        closeAgent,
        openAgent,
        setAgentMode,
    };
}
