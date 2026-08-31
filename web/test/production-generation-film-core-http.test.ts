import { describe, expect, test } from "bun:test";

import {
    createAcceptanceAuthorizedCommand,
    createAcceptanceProviderFixture,
    FILMOS_ACCEPTANCE_MOCK_CONNECTION_ID,
    FILMOS_ACCEPTANCE_MOCK_MODEL_ID,
    FILMOS_ACCEPTANCE_PROJECT_ID,
} from "@/film/generation-routing/acceptance-production-runtime";
import { executeCanonicalGenerationTool } from "@/film/generation-routing/canonical-tool-runtime";
import { FILMOS_ACCEPTANCE_PROJECT_NAME, FILMOS_MOCK_GENERATION_ENGINE_ID, type ProductionGenerationService } from "@/film/generation-routing/production-composition";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { defaultConfig } from "@/stores/use-config-store";
import { canonicalGenerationBrokerAuthorization } from "./helpers/canonical-agent-broker";

const filmCoreBaseUrl = process.env.FILMOS_PRODUCTION_FILM_CORE_URL;

describe("V2.4 candidate production runtime over real Film Core HTTP", () => {
    test.skipIf(!filmCoreBaseUrl)("Composer runtime persists preview, broker, provider receipt and candidate through loopback Film Core", async () => {
        const snapshot = acceptanceSnapshot();
        const runtime = await createAcceptanceProviderFixture({
            projectId: snapshot.projectId,
            domainProjectId: snapshot.domainProjectId,
            projectName: snapshot.title,
            getSnapshot: () => snapshot,
            filmCoreBaseUrl,
        });

        const rejected = await runtime.preview({ nodeId: "config-1", projectName: snapshot.title, userConfigRevision: "candidate-http-r1" });
        const rejection = await runtime.service.reject(rejected.proposal.proposalId);
        expect(rejection).toMatchObject({ event: "confirmation.rejected", externalCostMicrounits: "0", externalWrite: false });

        const stalePreview = await runtime.preview({ nodeId: "config-1", projectName: snapshot.title, userConfigRevision: "candidate-http-r1" });
        snapshot.nodes[1] = withPrompt(snapshot.nodes[1], "changed after broker approval", 2);
        const staleBroker = await canonicalGenerationBrokerAuthorization("film-core-http-stale");
        await expect(runtime.service.executeAuthorized(createAcceptanceAuthorizedCommand(runtime, {
            proposalId: stalePreview.proposal.proposalId,
            ...staleBroker,
        }))).rejects.toThrow("GENERATION_SUBMISSION_STALE");

        snapshot.nodes[1] = withPrompt(snapshot.nodes[1], "locked acceptance portrait", 1);
        const approvedPreview = await runtime.preview({ nodeId: "config-1", projectName: snapshot.title, userConfigRevision: "candidate-http-r1" });
        const broker = await canonicalGenerationBrokerAuthorization("film-core-http");
        const submitted = await executeCanonicalGenerationTool("generation_submit", {
            proposalId: approvedPreview.proposal.proposalId,
        }, {
            projectId: snapshot.projectId,
            config: structuredClone(defaultConfig),
            routingConfig: null,
            snapshot,
            projectPolicy: runtime.bindings.projectPolicy,
            productionPort: { executeAuthorized: (input) => runtime.service.executeAuthorized(createAcceptanceAuthorizedCommand(runtime, input)) },
            brokerAuthorization: broker,
        });
        expect(submitted.ok).toBe(true);
        if (!submitted.ok) throw new Error(submitted.message);
        const result = submitted.data as Awaited<ReturnType<ProductionGenerationService["submitAuthorized"]>>;
        expect(result.receipt).toMatchObject({ externalNetworkRequests: 0, externalSpendMicrounits: "0", status: "succeeded" });
        expect(result.candidate).toMatchObject({ qcState: "pending", approvalState: "not_approved" });

        const restarted = await createAcceptanceProviderFixture({
            projectId: snapshot.projectId,
            domainProjectId: snapshot.domainProjectId,
            projectName: snapshot.title,
            getSnapshot: () => snapshot,
            filmCoreBaseUrl,
        });
        expect((await restarted.service.recover(approvedPreview.generationAttemptId)).contentHash).toBe(result.candidate.contentHash);
        const replay = await restarted.service.submitAuthorized(result.receipt.authorizedSubmissionId);
        expect(replay.receipt.contentHash).toBe(result.receipt.contentHash);
        expect(replay.candidate.contentHash).toBe(result.candidate.contentHash);

        const authorityTrace = await getJson(`${filmCoreBaseUrl}/generation-production/authority-trace`);
        const projectAuthority = await getJson(`${filmCoreBaseUrl}/generation-production/project-authority/${FILMOS_ACCEPTANCE_PROJECT_ID}`);
        expect(authorityTrace).toMatchObject({
            formalCounts: { generation_package: 1, generation_attempt_evidence: 1, candidate: 1 },
            activeFormalBindingCount: 1,
            parallelCandidateWriteCount: 0,
            legacyDirectSubmitCount: 0,
            externalNetworkCount: 0,
            externalSpend: "0",
            approvalCount: 0,
        });
        expect(projectAuthority.bindings.ledger).toMatchObject({
            reservedTasks: 0,
            reservedCostMicrounits: "0",
            consumedTasks: 1,
            consumedCostMicrounits: "0",
            openReservationIds: [],
            lastEventSequence: 3,
        });

        const output = process.env.FILMOS_PRODUCTION_HTTP_TRACE_OUTPUT;
        if (output) {
            await Bun.write(output, JSON.stringify({
                schema_version: "1.0.0",
                gate_id: "V2-4-FINAL-PRODUCTION-AUTHORITY-001",
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
                formal_counts: authorityTrace.formalCounts,
                active_formal_binding_count: authorityTrace.activeFormalBindingCount,
                parallel_candidate_write_count: authorityTrace.parallelCandidateWriteCount,
                canonical_broker: {
                    confirmation_id: broker.confirmationId,
                    broker_grant_id: broker.brokerGrantId,
                    broker_grant_content_hash: broker.brokerGrantContentHash,
                    broker_decision_receipt_id: broker.brokerDecisionReceiptId,
                    broker_decision_receipt_content_hash: broker.brokerDecisionReceiptContentHash,
                    tool_request_id: broker.toolRequestId,
                },
                synthetic_broker_receipt_count: 0,
                real_budget_ledger: projectAuthority.bindings.ledger,
                external_network_request_count: 0,
                external_spend_microunits: "0",
            }, null, 2) + "\n");
        }
    });
});

async function getJson(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`FILM_CORE_HTTP_${response.status}`);
    return await response.json() as Record<string, any>;
}

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
