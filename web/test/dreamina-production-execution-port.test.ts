import { describe, expect, test } from "bun:test";

import {
    DreaminaProductionExecutionPort,
    dreaminaExecutionReadiness,
} from "@/film/generation-routing/dreamina-production-execution-port";
import type { ProductionAuthorizationBundle } from "@/film/generation-routing/production-composition";
import type { LocalDreaminaGenerationTask } from "@/services/local-dreamina-generation";

const at = "2026-08-31T00:00:00.000Z";

describe("Dreamina production execution port", () => {
    test("Pilot release policy blocks before authorization and Runtime network", async () => {
        let authorizationCalls = 0;
        let runtimeCalls = 0;
        const port = new DreaminaProductionExecutionPort({
            externalPaidSubmitEnabled: false,
            authorize: async () => { authorizationCalls += 1; return { authorized: true, authorizationId: "must-not-run" }; },
            loadAuthorization: async () => undefined,
            client: clientFixture(() => { runtimeCalls += 1; }),
            now: () => at,
        });
        await expect(port.submit({ projectName: "Pilot", authorization: authorizationFixture(), now: at }))
            .rejects.toThrow("PILOT_EXTERNAL_PAID_SUBMIT_DISABLED");
        expect({ authorizationCalls, runtimeCalls }).toEqual({ authorizationCalls: 0, runtimeCalls: 0 });
    });

    test("enabled release still requires a one-shot canonical user authorization", async () => {
        let runtimeCalls = 0;
        const port = new DreaminaProductionExecutionPort({
            externalPaidSubmitEnabled: true,
            authorize: async () => ({ authorized: false }),
            loadAuthorization: async () => undefined,
            client: clientFixture(() => { runtimeCalls += 1; }),
            now: () => at,
        });
        await expect(port.submit({ projectName: "Pilot", authorization: authorizationFixture(), now: at }))
            .rejects.toThrow("READY_FOR_USER_AUTHORIZATION");
        expect(runtimeCalls).toBe(0);
    });

    test("authorized adapter produces receipt, status, reconcile and downloadable output from the existing Runtime port", async () => {
        const authorization = authorizationFixture();
        let runtimeCalls = 0;
        const port = new DreaminaProductionExecutionPort({
            externalPaidSubmitEnabled: true,
            authorize: async (challenge) => ({ authorized: challenge.authorizedSubmissionId === "authorized-dreamina-1", authorizationId: "user-authorization-1" }),
            loadAuthorization: async () => authorization,
            client: clientFixture(() => { runtimeCalls += 1; }),
            now: () => at,
        });
        const receipt = await port.submit({ projectName: "Pilot", authorization, now: at });
        expect(runtimeCalls).toBe(1);
        expect(receipt).toMatchObject({ status: "succeeded", externalNetworkRequests: 1, externalSpendMicrounits: "100" });
        const lookup = { providerTaskId: receipt.providerTaskId, authorizedSubmissionId: receipt.authorizedSubmissionId, idempotencyKey: receipt.idempotencyKey };
        expect(await port.getStatus(lookup)).toMatchObject({ state: "succeeded", receipt: { contentHash: receipt.contentHash } });
        expect(await port.reconcile(lookup)).toMatchObject({ state: "succeeded", receipt: { contentHash: receipt.contentHash } });
        expect(await port.downloadOutputs(receipt)).toHaveLength(1);
    });

    test("readiness closes over Runtime, Catalog and Broker but never claims paid authorization automatically", () => {
        expect(dreaminaExecutionReadiness({ runtimeReady: true, catalogReady: true, canonicalBrokerReady: true, authorizationArmed: false }))
            .toBe("READY_FOR_USER_AUTHORIZATION");
        expect(dreaminaExecutionReadiness({ runtimeReady: true, catalogReady: true, canonicalBrokerReady: true, authorizationArmed: true }))
            .toBe("READY_FOR_USER_AUTHORIZATION");
        expect(dreaminaExecutionReadiness({ runtimeReady: false, catalogReady: true, canonicalBrokerReady: true, authorizationArmed: true }))
            .toBe("FAIL");
    });
});

function authorizationFixture(): ProductionAuthorizationBundle {
    return {
        preview: {
            projectId: "project-pilot",
            nodeId: "node-pilot",
            generationAttemptId: "attempt-pilot",
            compiledPromptReceipt: { text: "cinematic frame" },
            routeSnapshot: {
                engineId: "dreamina_cli",
                connectionId: "dreamina-local",
                modelId: "dreamina-image-3.0",
                capability: "image",
                normalizedParameters: { aspectRatio: "9:16", resolution: "2k" },
                references: [],
            },
            proposal: { estimateAvailable: true, estimatedCost: { unit: "credit", amountMicrounits: "100" } },
        },
        authorizedSubmission: {
            authorizedSubmissionId: "authorized-dreamina-1",
            confirmationId: "confirmation-1",
            brokerDecisionReceiptId: "broker-decision-1",
            idempotencyKey: "dreamina-idempotency-0001",
            catalogValidationSubmitNotAfter: "2026-09-01T00:00:00.000Z",
        },
    } as unknown as ProductionAuthorizationBundle;
}

function clientFixture(onRun: () => void) {
    const result = { mode: "image" as const, images: [{ dataUrl: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png", bytes: 8 }] };
    const task: LocalDreaminaGenerationTask = {
        id: "dreamina-provider-task-1",
        provider: "dreamina-cli",
        mode: "image",
        operation: "text-to-image",
        model: "dreamina-image-3.0",
        status: "succeeded",
        stage: "succeeded",
        receiptRecorded: true,
        createdAt: at,
        updatedAt: at,
        result,
    };
    return {
        async run(_input: unknown, _idempotencyKey: string, onTaskUpdate: (value: LocalDreaminaGenerationTask) => void) {
            onRun();
            onTaskUpdate(task);
            return result;
        },
        async query() { return task; },
        async refresh() { return task; },
    };
}
