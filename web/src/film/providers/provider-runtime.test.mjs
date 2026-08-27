import { describe, expect, test } from "bun:test";

import {
    BUILTIN_FILM_PROVIDERS,
    FilmProviderRegistry,
    importManualProviderResult,
    prepareSubmissionPackage,
} from "./provider-runtime";

const IDS = {
    package: "00000000-0000-4000-8000-000000000001",
    attempt: "00000000-0000-4000-8000-000000000002",
    prompt: "00000000-0000-4000-8000-000000000003",
    target: "00000000-0000-4000-8000-000000000004",
    referenceA: "00000000-0000-4000-8000-000000000005",
    referenceB: "00000000-0000-4000-8000-000000000006",
    candidate: "00000000-0000-4000-8000-000000000007",
    output: "00000000-0000-4000-8000-000000000008",
};

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

describe("Film Provider registry", () => {
    test("is disabled unless enabled is exactly true", async () => {
        const registry = new FilmProviderRegistry();
        expect(registry.enabled).toBe(false);
        await expect(prepareSubmissionPackage(registry, packageInput())).rejects.toMatchObject({ code: "provider_runtime_disabled" });
    });

    test("rejects duplicate Provider IDs", () => {
        const manual = BUILTIN_FILM_PROVIDERS.find((provider) => provider.providerId === "manual_web");
        expect(() => new FilmProviderRegistry({ providers: [manual, manual] })).toThrow("registered more than once");
    });

    test("keeps Flova explicitly unverified and refuses to prepare it", async () => {
        const registry = enabledRegistry();
        expect(registry.get("flova_cli")).toMatchObject({
            sourceState: "UNVERIFIED_SOURCE_ABSENT",
            boundary: "DEFERRED",
            externalExecution: "UNVERIFIED",
            capabilityIds: [],
        });
        await expect(
            prepareSubmissionPackage(registry, { ...packageInput(), providerId: "flova_cli" }),
        ).rejects.toMatchObject({ code: "provider_source_unverified" });
    });

    test("rejects a capability the verified source does not declare", async () => {
        await expect(
            prepareSubmissionPackage(enabledRegistry(), { ...packageInput(), providerId: "comfy_bridge", capabilityId: "video" }),
        ).rejects.toMatchObject({ code: "provider_capability_unsupported" });
    });

    test("does not allow an unverified custom descriptor to expose local operations", () => {
        const invalid = {
            providerId: "missing_provider",
            displayName: "Missing",
            sourceState: "UNVERIFIED_SOURCE_ABSENT",
            boundary: "DEFERRED",
            capabilityIds: ["image"],
            canPreparePackage: true,
            canImportManualResult: false,
            externalExecution: "UNVERIFIED",
            evidence: ["UNVERIFIED_SOURCE_ABSENT"],
        };
        expect(() => new FilmProviderRegistry({ enabled: true, providers: [invalid] })).toThrow("cannot expose local operations");
    });
});

describe("Submission Package", () => {
    test("is deterministic for canonical parameters and reference order", async () => {
        const registry = enabledRegistry();
        const left = await prepareSubmissionPackage(registry, packageInput());
        const right = await prepareSubmissionPackage(registry, {
            ...packageInput(),
            parameters: { size: { height: 1920, width: 1080 }, seed: 42, motion: "subtle" },
            references: [...packageInput().references].reverse(),
        });

        expect(left.parameterHash).toBe(right.parameterHash);
        expect(left.referenceHash).toBe(right.referenceHash);
        expect(left.inputHash).toBe(right.inputHash);
        expect(left.ref.contentHash).toBe(right.ref.contentHash);
        expect(left.lifecycle).toBe("prepared");
        expect(left.externalSubmission).toBe("not_submitted");
        expect(left.files.map((file) => file.name)).toEqual([
            "task.json",
            "prompt.txt",
            "references.json",
            "acceptance-checklist.md",
        ]);
    });

    test("binds stable Film IDs, expected version/hash, Host IDs and authorization evidence", async () => {
        const result = await prepareSubmissionPackage(enabledRegistry(), packageInput());
        expect(result.ref).toMatchObject({ filmEntityId: IDS.package, entityType: "generation_package", version: 1 });
        expect(result.target).toEqual({ filmEntityId: IDS.target, expectedVersion: 7, expectedContentHash: HASH_A });
        expect(result.hostProjectId).toBe("host-project-01");
        expect(result.references[0]).toMatchObject({
            filmReferenceId: IDS.referenceA,
            hostReferenceId: "host-asset-version-01",
            authorization: { decision: "authorized_for_provider_input", evidenceId: "grant-01", scopeHash: HASH_B },
        });
        expect(result.ref.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    test("rejects secrets, locator fields, URLs, data payloads and absolute paths in parameters", async () => {
        const rejectedParameters = [
            { apiKey: "secret" },
            { nested: { authorization: "Bearer secret" } },
            { output_url: "resource-01" },
            { reference: "https://example.test/image.png" },
            { reference: "data:image/png;base64,AAAA" },
            { reference: "/Users/example/image.png" },
        ];
        for (const parameters of rejectedParameters) {
            await expect(
                prepareSubmissionPackage(enabledRegistry(), { ...packageInput(), parameters }),
            ).rejects.toBeInstanceOf(Error);
        }
    });
});

describe("Manual Result Import", () => {
    test("fails closed on expected_version, input hash and package tampering", async () => {
        const registry = enabledRegistry();
        const generationPackage = await prepareSubmissionPackage(registry, packageInput());
        await expect(importManualProviderResult(registry, importInput(generationPackage, { expectedTargetVersion: 8 }))).rejects.toMatchObject({
            code: "expected_version_conflict",
        });
        await expect(importManualProviderResult(registry, importInput(generationPackage, { expectedInputHash: HASH_C }))).rejects.toMatchObject({
            code: "input_hash_conflict",
        });
        await expect(importManualProviderResult(registry, importInput(generationPackage, { expectedTargetContentHash: HASH_B }))).rejects.toMatchObject({
            code: "expected_content_hash_conflict",
        });
        const tampered = { ...generationPackage, promptText: "tampered" };
        await expect(importManualProviderResult(registry, importInput(tampered))).rejects.toMatchObject({
            code: "submission_package_input_hash_mismatch",
        });
    });

    test("records provider/task/receipt/hash/parameters/manual source and creates Candidate only", async () => {
        const registry = enabledRegistry();
        const generationPackage = await prepareSubmissionPackage(registry, packageInput());
        const candidate = await importManualProviderResult(registry, importInput(generationPackage));

        expect(candidate.ref).toMatchObject({ filmEntityId: IDS.candidate, entityType: "candidate", version: 1 });
        expect(candidate.providerEvidence).toEqual({
            providerId: "manual_web",
            providerTaskId: "manual-task-001",
            receiptId: "manual-receipt-001",
            receiptHash: HASH_C,
            receiptCapturedAt: "2026-08-28T02:01:00.000Z",
            promptHash: generationPackage.promptHash,
            parameterHash: generationPackage.parameterHash,
            inputHash: generationPackage.inputHash,
        });
        expect(candidate.parameters).toEqual({ motion: "subtle", seed: 42, size: { height: 1920, width: 1080 } });
        expect(candidate.manualImport).toEqual({
            sourceId: "manual-export-001",
            sourceKind: "manual_download",
            importedBy: "host-user-001",
            importedAt: "2026-08-28T02:02:00.000Z",
            authorizationEvidenceId: "import-grant-001",
        });
        expect(candidate.outputs).toEqual([
            {
                filmRepresentationId: IDS.output,
                hostResourceId: "host-resource-001",
                outputKind: "image",
                contentHash: HASH_B,
                mimeType: "image/png",
                bytes: 1024,
            },
        ]);
        expect(candidate).toMatchObject({ status: "candidate", reviewState: "pending", approvalState: "not_approved" });
        expect("approvalId" in candidate).toBe(false);
        expect(JSON.stringify(candidate)).not.toMatch(/(?:data:image|https?:\/\/|\/Users\/|apiKey|secret)/i);
    });

    test("requires opaque Provider/Receipt/Host resource IDs and at least one output", async () => {
        const registry = enabledRegistry();
        const generationPackage = await prepareSubmissionPackage(registry, packageInput());
        await expect(
            importManualProviderResult(registry, importInput(generationPackage, { providerTaskId: "https://provider.test/task/1" })),
        ).rejects.toMatchObject({ code: "opaque_id_invalid" });
        await expect(
            importManualProviderResult(registry, importInput(generationPackage, { outputs: [] })),
        ).rejects.toMatchObject({ code: "manual_result_outputs_empty" });
    });
});

function enabledRegistry() {
    return new FilmProviderRegistry({ enabled: true });
}

function packageInput() {
    return {
        submissionPackageId: IDS.package,
        generationAttemptId: IDS.attempt,
        promptDraftId: IDS.prompt,
        hostProjectId: "host-project-01",
        target: { filmEntityId: IDS.target, expectedVersion: 7, expectedContentHash: HASH_A },
        providerId: "manual_web",
        capabilityId: "image",
        promptText: "Locked character portrait, neutral studio lighting.",
        parameters: { motion: "subtle", seed: 42, size: { width: 1080, height: 1920 } },
        references: [
            {
                filmReferenceId: IDS.referenceB,
                hostReferenceId: "host-asset-version-02",
                referenceKind: "asset_version",
                contentHash: HASH_C,
                authorization: { decision: "authorized_for_provider_input", evidenceId: "grant-02", scopeHash: HASH_C },
            },
            {
                filmReferenceId: IDS.referenceA,
                hostReferenceId: "host-asset-version-01",
                referenceKind: "asset_version",
                contentHash: HASH_B,
                authorization: { decision: "authorized_for_provider_input", evidenceId: "grant-01", scopeHash: HASH_B },
            },
        ],
        acceptanceChecklist: ["Identity remains consistent", "No unapproved logos or text"],
        preparedAt: "2026-08-28T02:00:00.000Z",
    };
}

function importInput(generationPackage, overrides = {}) {
    return {
        candidateId: IDS.candidate,
        generationPackage,
        expectedTargetVersion: generationPackage.target.expectedVersion,
        expectedTargetContentHash: generationPackage.target.expectedContentHash,
        expectedInputHash: generationPackage.inputHash,
        providerTaskId: "manual-task-001",
        receipt: {
            receiptId: "manual-receipt-001",
            contentHash: HASH_C,
            capturedAt: "2026-08-28T02:01:00.000Z",
        },
        manualSource: {
            sourceId: "manual-export-001",
            sourceKind: "manual_download",
            importedBy: "host-user-001",
            importedAt: "2026-08-28T02:02:00.000Z",
            authorizationEvidenceId: "import-grant-001",
        },
        outputs: [
            {
                filmRepresentationId: IDS.output,
                hostResourceId: "host-resource-001",
                outputKind: "image",
                contentHash: HASH_B,
                mimeType: "image/png",
                bytes: 1024,
            },
        ],
        ...overrides,
    };
}
