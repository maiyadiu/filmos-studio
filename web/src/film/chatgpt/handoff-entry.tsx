import { useCallback, useEffect, useMemo, useState } from "react";

import type { ProjectDetail } from "@/services/api/projects";

import { parseUntrustedProposalPackage, type ChatGPTAuthorizedProject } from "./contracts";
import { ChatGPTHandoffPanel, type ChatGPTHandoffPanelState } from "./handoff-panel";
import { createFilmChatGPTHandoffClient, resolveFilmChatGPTHandoffConfig, type FilmChatGPTHandoffClient } from "./handoff-client";

export function FilmChatGPTHandoffEntry({
    detail,
    env,
    client,
    openExternal,
}: {
    detail: ProjectDetail;
    env?: Record<string, unknown>;
    client?: FilmChatGPTHandoffClient;
    openExternal?: (url: string) => void;
}) {
    const config = resolveFilmChatGPTHandoffConfig(env);
    if (!config.enabled) return null;
    return <EnabledFilmChatGPTHandoffEntry detail={detail} config={config} client={client} openExternal={openExternal} />;
}

function EnabledFilmChatGPTHandoffEntry({
    detail,
    config,
    client: injectedClient,
    openExternal,
}: {
    detail: ProjectDetail;
    config: ReturnType<typeof resolveFilmChatGPTHandoffConfig>;
    client?: FilmChatGPTHandoffClient;
    openExternal?: (url: string) => void;
}) {
    const client = useMemo(() => injectedClient ?? createFilmChatGPTHandoffClient({ baseUrl: config.baseUrl, proposalHandoffEnabled: config.proposalHandoffEnabled }), [config.baseUrl, config.proposalHandoffEnabled, injectedClient]);
    const [state, setState] = useState<ChatGPTHandoffPanelState>({ state: "loading" });
    const [refreshVersion, setRefreshVersion] = useState(0);
    const projectId = detail.project.id;
    const refresh = useCallback(() => setRefreshVersion((value) => value + 1), []);
    useEffect(() => {
        const controller = new AbortController();
        setState({ state: "loading" });
        void client.getStatus(projectId, controller.signal).then((status) => setState({ state: "ready", status })).catch((error) => {
            if (!controller.signal.aborted) setState({ state: "error", message: error instanceof Error ? error.message : "FilmOS ChatGPT 本机边界不可用" });
        });
        return () => controller.abort();
    }, [client, projectId, refreshVersion]);
    const currentGrant = (): ChatGPTAuthorizedProject => {
        const grant = state.state === "ready" ? state.status.authorized_project : null;
        if (!grant || grant.project_id !== projectId) throw new Error("当前项目没有可撤销的 Project Grant");
        return grant;
    };
    return <ChatGPTHandoffPanel
        project={{ id: projectId, name: detail.project.name }}
        state={state}
        proposalHandoffEnabled={config.proposalHandoffEnabled}
        onRefresh={refresh}
        onPreviewProposal={async (file) => client.previewProposal(projectId, parseUntrustedProposalPackage(await file.text()))}
        onRevoke={async () => { await client.revokeGrant(currentGrant()); refresh(); }}
        onOpenChatGPT={() => {
            const url = "https://chatgpt.com/";
            if (openExternal) openExternal(url);
            else if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
        }}
    />;
}
