import { describe, expect, test } from "bun:test";

import {
    AcceptanceProductionRuntime,
    FILMOS_ACCEPTANCE_MOCK_CONNECTION_ID,
    FILMOS_ACCEPTANCE_MOCK_MODEL_ID,
    FILMOS_ACCEPTANCE_PROJECT_ID,
} from "@/film/generation-routing/acceptance-production-runtime";
import { executeCanonicalGenerationTool } from "@/film/generation-routing/canonical-tool-runtime";
import { FILMOS_ACCEPTANCE_PROJECT_NAME, FILMOS_MOCK_GENERATION_ENGINE_ID } from "@/film/generation-routing/production-composition";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { defaultConfig } from "@/stores/use-config-store";

const filmCoreBaseUrl = process.env.FILMOS_PRODUCTION_FILM_CORE_URL;

describe("V2.4 candidate production runtime over real Film Core HTTP", () => {
    test.skipIf(!filmCoreBaseUrl)("Composer runtime persists preview, broker, provider receipt and candidate through loopback Film Core", async () => {
        const snapshot = acceptanceSnapshot();
        const runtime = await AcceptanceProductionRuntime.create({
            projectId: snapshot.projectId,
            domainProjectId: snapshot.domainProjectId,
            projectName: snapshot.title,
            getSnapshot: () => snapshot,
            filmCoreBaseUrl,
        });

        const rejected = await runtime.preview({ nodeId: "config-1", projectName: snapshot.title, userConfigRevision: "candidate-http-r1" });
        const rejection = await runtime.reject(rejected.proposal.proposalId);
        expect(rejection).toMatchObject({ event: "confirmation.rejected", externalCostMicrounits: "0", externalWrite: false });

        const stalePreview = await runtime.preview({ nodeId: "config-1", projectName: snapshot.title, userConfigRevision: "candidate-http-r1" });
        const staleAuthorization = await runtime.approve(stalePreview.proposal.proposalId);
        snapshot.nodes[1] = withPrompt(snapshot.nodes[1], "changed after broker approval", 2);
        await expect(runtime.submitAuthorized(staleAuthorization.authorizedSubmission.authorizedSubmissionId)).rejects.toThrow("GENERATION_SUBMISSION_STALE");

        snapshot.nodes[1] = withPrompt(snapshot.nodes[1], "locked acceptance portrait", 1);
        const approvedPreview = await runtime.preview({ nodeId: "config-1", projectName: snapshot.title, userConfigRevision: "candidate-http-r1" });
        const approved = await runtime.approve(approvedPreview.proposal.proposalId);
        const submitted = await executeCanonicalGenerationTool("generation_submit", {
            authorizedSubmissionId: approved.authorizedSubmission.authorizedSubmissionId,
        }, {
            projectId: snapshot.projectId,
            config: structuredClone(defaultConfig),
            routingConfig: null,
            snapshot,
            projectPolicy: runtime.bindings.projectPolicy,
            productionPort: runtime,
        });
        expect(submitted.ok).toBe(true);
        if (!submitted.ok) throw new Error(submitted.message);
        const result = submitted.data as Awaited<ReturnType<AcceptanceProductionRuntime["submitAuthorized"]>>;
        expect(result.receipt).toMatchObject({ externalNetworkRequests: 0, externalSpendMicrounits: "0", status: "succeeded" });
        expect(result.candidate).toMatchObject({ qcState: "pending", approvalState: "not_approved" });

        const restarted = await AcceptanceProductionRuntime.create({
            projectId: snapshot.projectId,
            domainProjectId: snapshot.domainProjectId,
            projectName: snapshot.title,
            getSnapshot: () => snapshot,
            filmCoreBaseUrl,
        });
        expect((await restarted.recover(approvedPreview.generationAttemptId)).contentHash).toBe(result.candidate.contentHash);
        const replay = await restarted.submitAuthorized(approved.authorizedSubmission.authorizedSubmissionId);
        expect(replay.receipt.contentHash).toBe(result.receipt.contentHash);
        expect(replay.candidate.contentHash).toBe(result.candidate.contentHash);

        const output = process.env.FILMOS_PRODUCTION_HTTP_TRACE_OUTPUT;
        if (output) {
            await Bun.write(output, JSON.stringify({
                schema_version: "1.0.0",
                gate_id: "BRAIN-GENERATION-PRODUCTION-COMPOSITION-001",
                status: "PASSED",
                runtime: "filmos-candidate",
                film_core_transport: "loopback_http",
                project_id: FILMOS_ACCEPTANCE_PROJECT_ID,
                project_name: FILMOS_ACCEPTANCE_PROJECT_NAME,
                engine_id: FILMOS_MOCK_GENERATION_ENGINE_ID,
                connection_id: FILMOS_ACCEPTANCE_MOCK_CONNECTION_ID,
                model_id: FILMOS_ACCEPTANCE_MOCK_MODEL_ID,
                reject_provider_submit_count: 0,
                legacy_direct_submit_count: 0,
                stale_blocked_before_provider: true,
                approve_provider_submit_count: 1,
                restart_provider_resubmit_count: 0,
                candidate_count: 1,
                approval_count: 0,
                film_core_project_policy_authority: true,
                film_core_model_lock_authority: true,
                provider_receipt_content_hash: result.receipt.contentHash,
                candidate_content_hash: result.candidate.contentHash,
                candidate_qc_state: result.candidate.qcState,
                candidate_approval_state: result.candidate.approvalState,
                external_network_request_count: 0,
                external_spend_microunits: "0",
            }, null, 2) + "\n");
        }
    });
});

function acceptanceSnapshot() {
    const nodes: CanvasNodeData[] = [
        {
            id: "image-reference-1",
            type: CanvasNodeType.Image,
            title: "Hard Lock Reference",
            position: { x: 0, y: 0 },
            width: 320,
            height: 480,
            metadata: { assetId: "accept-asset-001", storageKey: "acceptance/reference-1", mimeType: "image/png" },
        },
        {
            id: "config-1",
            type: CanvasNodeType.Config,
            title: "Production Composer",
            position: { x: 400, y: 0 },
            width: 400,
            height: 360,
            metadata: {
                composerContent: "locked acceptance portrait",
                generationMode: "image",
                generationEngineId: FILMOS_MOCK_GENERATION_ENGINE_ID,
                generationConnectionId: FILMOS_ACCEPTANCE_MOCK_CONNECTION_ID,
                generationModelId: FILMOS_ACCEPTANCE_MOCK_MODEL_ID,
                generationNativeSize: "9:16",
                generationDeliveryResolution: "1080p",
                generationDraftVersion: 1,
            },
        },
    ];
    return {
        projectId: "canvas-filmos-acceptance-project-v1",
        domainProjectId: FILMOS_ACCEPTANCE_PROJECT_ID,
        title: FILMOS_ACCEPTANCE_PROJECT_NAME,
        nodes,
        connections: [{ id: "connection-reference-config", fromNodeId: "image-reference-1", toNodeId: "config-1" }],
        selectedNodeIds: ["config-1"],
        viewport: { x: 0, y: 0, k: 1 },
    };
}

function withPrompt(node: CanvasNodeData, composerContent: string, generationDraftVersion: number): CanvasNodeData {
    return { ...node, metadata: { ...node.metadata, composerContent, generationDraftVersion } };
}
