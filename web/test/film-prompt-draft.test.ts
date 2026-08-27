import { describe, expect, it } from "bun:test";

import {
    FILM_PROMPT_KERNEL_FLAG,
    PromptDraftCompileError,
    compilePromptDraft,
    sha256Text,
    type PromptDraftCompilerInput,
} from "@/film/prompt";

async function validInput(): Promise<PromptDraftCompilerInput> {
    const directorIrText = "叙事目标：人物在门口停步。表演：右手握住门把，视线保持在室内目标。";
    const visualLockText = "人物位于画面左侧；门位于右侧；禁止反转轴线；服装与道具版本保持不变。";
    const templateContent = "将导演 IR、视觉锁和资产绑定无损编译为目标 Provider 可执行提示词；不得自行补写未提供事实。";
    return {
        schemaVersion: "filmos.prompt-compiler-input.v0",
        feature: { key: FILM_PROMPT_KERNEL_FLAG, enabled: true },
        draft: {
            filmEntityId: "11111111-1111-4111-8111-111111111111",
            expectedVersion: 0,
            targetVersion: 1,
        },
        scope: {
            project: binding("22222222-2222-4222-8222-222222222222", "film_project", "a", "project", "host-project-1"),
            shot: binding("33333333-3333-4333-8333-333333333333", "shot", "b", "shot", "host-shot-1"),
            directorUnit: {
                ...binding("44444444-4444-4444-8444-444444444444", "director_unit", "0", "unit", "host-unit-1"),
                contentHash: await sha256Text(directorIrText),
            },
        },
        directorIrText,
        visualLock: {
            binding: {
                ...binding("55555555-5555-4555-8555-555555555555", "visual_lock", "0", "asset_version", "host-style-version-1"),
                contentHash: await sha256Text(visualLockText),
            },
            lockText: visualLockText,
        },
        template: {
            hostPromptTemplateId: "host-template-1",
            operation: "film.prompt.compile",
            version: 3,
            contentHash: await sha256Text(templateContent),
            content: templateContent,
        },
        assets: [
            {
                binding: binding("77777777-7777-4777-8777-777777777777", "asset_version", "d", "asset_version", "host-asset-version-2"),
                role: "prop",
                priority: 80,
            },
            {
                binding: binding("66666666-6666-4666-8666-666666666666", "asset_version", "c", "asset_version", "host-asset-version-1"),
                role: "character",
                priority: 100,
            },
        ],
        providerCapability: {
            profileId: "manual-video-v1",
            profileVersion: 1,
            providerKind: "manual_web",
            outputKind: "video",
            dialect: "plain_zh",
            supports: {
                referenceAssets: true,
                negativePrompt: true,
                deterministicSeed: false,
                cameraControl: true,
                audio: false,
            },
            requires: {
                aspectRatio: true,
                durationSeconds: true,
            },
            limits: {
                maxPromptCharacters: 12_000,
                maxReferenceAssets: 4,
            },
        },
        providerParameters: {
            aspectRatio: "16:9",
            durationSeconds: 5,
            seed: null,
            negativePrompt: "换脸，服装漂移，轴线反转",
        },
    };
}

describe("Film PromptDraft compiler", () => {
    it("is deterministic, normalizes asset order and binds every source hash", async () => {
        const firstInput = await validInput();
        const secondInput = await validInput();
        secondInput.assets = [...secondInput.assets].reverse();

        const first = await compilePromptDraft(firstInput);
        const second = await compilePromptDraft(secondInput);

        expect(second).toEqual(first);
        expect(first.audit.status).toBe("PASS");
        expect(first.promptDraft.ref.content_hash).toBe(await sha256Text(first.promptDraft.prompt_text));
        expect(first.bindings.expected_version).toBe(0);
        expect(first.promptDraft.prompt_text).toContain(firstInput.scope.directorUnit.contentHash);
        expect(first.promptDraft.prompt_text).toContain(firstInput.visualLock.binding.contentHash);
        expect(first.bindings.assets.map((asset) => asset.binding.contentHash)).toEqual(["c".repeat(64), "d".repeat(64)]);
    });

    it("requires an explicit feature enable and never exposes a submission or approval action", async () => {
        const input = await validInput();
        input.feature.enabled = false;
        await expect(compilePromptDraft(input)).rejects.toBeInstanceOf(PromptDraftCompileError);

        input.feature.enabled = true;
        const compiled = await compilePromptDraft(input);
        expect(compiled.lifecycleBoundary).toEqual({
            submission_state: "NOT_SUBMITTED",
            generated_result_state: "CANDIDATE_ONLY",
            approval_state: "SEPARATE_HUMAN_ACTION_REQUIRED",
        });
        expect(Object.keys(compiled)).not.toContain("submit");
        expect(Object.keys(compiled)).not.toContain("approve");
    });

    it("rejects stale content hashes, version races and incomplete provider settings", async () => {
        const stale = await validInput();
        stale.directorIrText += "额外改动";
        await expectCompileFailure(stale, "DIRECTOR_IR_HASH_MISMATCH");

        const raced = await validInput();
        raced.draft.targetVersion = 3;
        await expectCompileFailure(raced, "TARGET_VERSION_INVALID");

        const implicit = await validInput();
        delete (implicit.providerParameters as Partial<typeof implicit.providerParameters>).seed;
        await expectCompileFailure(implicit, "PROVIDER_PARAMETERS_INCOMPLETE");
    });

    it("fails closed when provider capability cannot carry the bound references", async () => {
        const input = await validInput();
        input.providerCapability.supports.referenceAssets = false;
        input.providerCapability.limits.maxReferenceAssets = 0;
        await expectCompileFailure(input, "REFERENCE_ASSETS_UNSUPPORTED");
    });

    it("changes both input and prompt lineage when locked visual content changes", async () => {
        const beforeInput = await validInput();
        const before = await compilePromptDraft(beforeInput);
        const afterInput = await validInput();
        afterInput.visualLock.lockText = "人物位于画面左侧；门位于右侧；禁止反转轴线；服装、道具及光线版本保持不变。";
        afterInput.visualLock.binding.contentHash = await sha256Text(afterInput.visualLock.lockText);
        const after = await compilePromptDraft(afterInput);

        expect(after.hashes.input_hash).not.toBe(before.hashes.input_hash);
        expect(after.hashes.prompt_hash).not.toBe(before.hashes.prompt_hash);
    });

    it("changes lineage when an asset version hash changes", async () => {
        const beforeInput = await validInput();
        const before = await compilePromptDraft(beforeInput);
        const afterInput = await validInput();
        afterInput.assets[0]!.binding.contentHash = "e".repeat(64);
        const after = await compilePromptDraft(afterInput);

        expect(after.hashes.input_hash).not.toBe(before.hashes.input_hash);
        expect(after.hashes.prompt_hash).not.toBe(before.hashes.prompt_hash);
        expect(after.bindings.assets.some((asset) => asset.binding.contentHash === "e".repeat(64))).toBe(true);
    });

    it("returns a structured failure before normalization when nested input is missing", async () => {
        const input = await validInput();
        delete (input as Partial<PromptDraftCompilerInput>).scope;
        await expectCompileFailure(input, "PROJECT_MISSING");
    });

    it("rejects path-like Host references, unknown Host kinds and unverified Flova capability", async () => {
        const pathLike = await validInput();
        pathLike.scope.project.hostReferences = [{ kind: "project", id: "/tmp/project.json" }];
        await expectCompileFailure(pathLike, "PROJECT_HOST_REF_0_ID_INVALID");

        const unknownKind = await validInput();
        unknownKind.scope.project.hostReferences = [{ kind: "collection" as never, id: "host-project-1" }];
        await expectCompileFailure(unknownKind, "PROJECT_HOST_REF_0_KIND_INVALID");

        const flova = await validInput();
        flova.providerCapability.providerKind = "flova_cli";
        await expectCompileFailure(flova, "CAPABILITY_PROVIDER_UNVERIFIED");
    });
});

function binding(filmEntityId: string, entityType: string, hashCharacter: string, kind: "project" | "unit" | "shot" | "asset_version", id: string) {
    return {
        filmEntityId,
        entityType,
        version: 1,
        contentHash: hashCharacter.repeat(64),
        hostReferences: [{ kind, id }],
    };
}

async function expectCompileFailure(input: PromptDraftCompilerInput, code: string) {
    try {
        await compilePromptDraft(input);
        throw new Error("expected compile failure");
    } catch (error) {
        expect(error).toBeInstanceOf(PromptDraftCompileError);
        expect((error as PromptDraftCompileError).report.findings.some((finding) => finding.code === code && finding.status === "FAIL")).toBe(true);
    }
}
