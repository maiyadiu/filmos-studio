import { describe, expect, test } from "bun:test";

import {
    buildRemotePublishPreview,
    confirmRemoteSyncPreviewLocally,
    createMemoryRemoteSyncSessionStore,
    createRemoteSyncPolicy,
    DEFAULT_REMOTE_SYNC_POLICY,
    recoverLatestRemoteSyncSession,
    type FormalFilmReference,
    type RemotePublishPlanInput,
} from "../src/film/sync";

const fixture = JSON.parse(await Bun.file(new URL("./fixtures/film-remote-plan.json", import.meta.url)).text()) as RemotePublishPlanInput;

function enabledPolicy(authority_mode: "LOCAL_AUTHORITY" | "REMOTE_AUTHORITY" | "HYBRID_LOCAL_AUTHORITY" = "LOCAL_AUTHORITY") {
    return createRemoteSyncPolicy({ enabled: true, authority_mode });
}

function cloneFixture() {
    return structuredClone(fixture);
}

describe("Film remote authority and publish preview", () => {
    test("defaults to disabled Local Authority with no network or implicit upload", async () => {
        expect(DEFAULT_REMOTE_SYNC_POLICY).toEqual({
            enabled: false,
            authority_mode: "LOCAL_AUTHORITY",
            allow_network: false,
            allow_implicit_local_asset_upload: false,
            conflict_policy: "BLOCK",
        });
        const preview = await buildRemotePublishPreview(cloneFixture());
        expect(preview.execution_state).toBe("PREVIEW_ONLY");
        expect(preview.manifest_version).toBe(1);
        expect(preview.publishable_after_explicit_execution).toBe(false);
        expect(preview.blockers.map((item) => item.code)).toContain("FEATURE_DISABLED");
        expect(preview.network).toEqual({ executed: false, actions: [], uploaded_asset_ids: [], publication_receipts: [] });
        expect(preview.manifest_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    test("a selected LOCAL_ONLY asset creates a proxy job and never an upload intent", async () => {
        const input = cloneFixture();
        input.assets[0] = {
            availability: "LOCAL_ONLY",
            local: input.assets[0].local,
        };
        const preview = await buildRemotePublishPreview(input, enabledPolicy());
        expect(preview.proxy_jobs).toEqual([
            {
                source_ref: input.assets[0].local,
                operation: "GENERATE_LOCAL_REVIEW_PROXY",
                state: "NOT_GENERATED",
                upload_intent: "NONE",
            },
        ]);
        expect(preview.selection.assets[0].publication_ref).toBeNull();
        expect(preview.selection.assets[0].implicit_upload).toBe(false);
        expect(preview.blockers.map((item) => item.code)).toContain("LOCAL_ASSET_PROXY_REQUIRED");
        expect(preview.network.actions).toEqual([]);
        expect(preview.publishable_after_explicit_execution).toBe(false);
    });

    test("version, hash, and identity divergence are explicit blockers", async () => {
        const cases: Array<["VERSION_DIVERGENCE" | "HASH_DIVERGENCE" | "FILM_ID_MISMATCH" | "ENTITY_TYPE_MISMATCH", (remote: FormalFilmReference) => void]> = [
            [
                "VERSION_DIVERGENCE",
                (remote) => {
                    remote.version += 1;
                },
            ],
            [
                "HASH_DIVERGENCE",
                (remote) => {
                    remote.content_hash = "f".repeat(64);
                },
            ],
            [
                "FILM_ID_MISMATCH",
                (remote) => {
                    remote.film_entity_id = "99999999-9999-4999-8999-999999999999";
                },
            ],
            [
                "ENTITY_TYPE_MISMATCH",
                (remote) => {
                    remote.entity_type = "asset_version";
                },
            ],
        ];
        for (const [expectedCode, mutate] of cases) {
            const input = cloneFixture();
            const local = input.content_units[0].local!;
            input.content_units[0].remote = structuredClone(local);
            mutate(input.content_units[0].remote);
            const preview = await buildRemotePublishPreview(input, enabledPolicy("HYBRID_LOCAL_AUTHORITY"));
            expect(preview.conflicts.map((item) => item.code)).toContain(expectedCode);
            expect(preview.conflicts.every((item) => item.human_decision_required)).toBe(true);
            expect(preview.selection.content_units[0].selected_ref).toBeNull();
            expect(preview.publishable_after_explicit_execution).toBe(false);
        }
    });

    test("REMOTE_AUTHORITY requires a matching remote fact and never falls back silently", async () => {
        const missing = await buildRemotePublishPreview(cloneFixture(), enabledPolicy("REMOTE_AUTHORITY"));
        expect(missing.blockers.map((item) => item.code)).toContain("MISSING_REMOTE_FACT");
        expect(missing.selection.content_units[0].selected_ref).toBeNull();

        const input = cloneFixture();
        input.content_units[0].remote = structuredClone(input.content_units[0].local!);
        input.assets[0].remote = structuredClone(input.assets[0].local!);
        input.assets[0].availability = "REMOTE_RESOURCE";
        const ready = await buildRemotePublishPreview(input, enabledPolicy("REMOTE_AUTHORITY"));
        expect(ready.selection.content_units[0].selected_ref).toEqual(input.content_units[0].remote);
        expect(ready.selection.assets[0].publication_ref).toEqual(input.assets[0].remote);
        expect(ready.conflicts).toEqual([]);
        expect(ready.publishable_after_explicit_execution).toBe(true);
        expect(ready.network.executed).toBe(false);
    });

    test("remote results stay Candidate-only and require local approval", async () => {
        const preview = await buildRemotePublishPreview(cloneFixture(), enabledPolicy());
        expect(preview.inbound_results).toHaveLength(1);
        expect(preview.inbound_results[0].import_state).toBe("CANDIDATE_ONLY");
        expect(preview.inbound_results[0].local_approval).toBe("REQUIRED");
        expect(preview.inbound_results[0].can_auto_promote).toBe(false);
    });

    test("every formal reference requires UUIDv4, version, content hash, and Host opaque ID", async () => {
        const invalidUuid = cloneFixture();
        invalidUuid.content_units[0].local!.film_entity_id = "host-unit-1";
        await expect(buildRemotePublishPreview(invalidUuid, enabledPolicy())).rejects.toThrow("UUIDv4");

        const invalidVersion = cloneFixture();
        invalidVersion.assets[0].local!.version = 0;
        await expect(buildRemotePublishPreview(invalidVersion, enabledPolicy())).rejects.toThrow("version");

        const invalidHash = cloneFixture();
        invalidHash.assets[0].proxy_ref!.content_hash = "short";
        await expect(buildRemotePublishPreview(invalidHash, enabledPolicy())).rejects.toThrow("SHA-256");

        const invalidHost = cloneFixture();
        invalidHost.remote_results![0].candidate_ref.host_ref.opaque_id = "/tmp/result.json";
        await expect(buildRemotePublishPreview(invalidHost, enabledPolicy())).rejects.toThrow("Host opaque ID");

        const invalidCandidate = cloneFixture();
        invalidCandidate.remote_results![0].candidate_ref.entity_type = "approved_asset";
        await expect(buildRemotePublishPreview(invalidCandidate, enabledPolicy())).rejects.toThrow("Candidate");

        const invalidAvailability = cloneFixture();
        invalidAvailability.assets[0].availability = "REMOTE_RESOURCE";
        await expect(buildRemotePublishPreview(invalidAvailability, enabledPolicy())).rejects.toThrow("REMOTE_RESOURCE");
    });

    test("unsafe policy cannot enable network publication or implicit local asset upload", () => {
        expect(() => createRemoteSyncPolicy({ allow_network: true })).toThrow("不得执行网络发布");
        expect(() => createRemoteSyncPolicy({ allow_implicit_local_asset_upload: true })).toThrow("不得隐式上传");
    });

    test("the same local fixture yields the same manifest hash", async () => {
        const first = await buildRemotePublishPreview(cloneFixture(), enabledPolicy());
        const second = await buildRemotePublishPreview(cloneFixture(), enabledPolicy());
        expect(first.manifest_hash).toBe(second.manifest_hash);
    });
});

describe("Film remote local confirmation sessions", () => {
    const now = () => "2026-08-28T12:00:00.000Z";
    const createId = () => "receipt-local-001";

    test("Human confirmation persists a recoverable local-only receipt and is idempotent by confirmation ID", async () => {
        const plan = cloneFixture();
        const preview = await buildRemotePublishPreview(plan, enabledPolicy());
        const store = createMemoryRemoteSyncSessionStore();
        const input = {
            userScope: "user-remote-001",
            hostProjectId: plan.host_project_id,
            plan,
            policy: enabledPolicy(),
            humanConfirmed: true,
            confirmationId: "confirm-local-001",
            expectedManifestVersion: preview.manifest_version,
            expectedManifestHash: preview.manifest_hash,
        } as const;

        const first = await confirmRemoteSyncPreviewLocally(input, { store, now, createId });
        const repeated = await confirmRemoteSyncPreviewLocally(input, { store, now, createId: () => "must-not-be-used" });

        expect(first).toEqual(repeated);
        expect(store.writeCount).toBe(1);
        expect(first.state).toBe("LOCALLY_CONFIRMED_NOT_EXECUTED");
        expect(first.receipt).toMatchObject({
            confirmation_id: "confirm-local-001",
            execution_state: "NOT_EXECUTED",
            network_executed: false,
            inbound_result_policy: "CANDIDATE_ONLY",
            uploaded_asset_ids: [],
            publication_receipts: [],
        });
        expect(first.preview.inbound_results.every((result) => result.import_state === "CANDIDATE_ONLY" && result.local_approval === "REQUIRED" && !result.can_auto_promote)).toBe(true);

        const recovered = await recoverLatestRemoteSyncSession("user-remote-001", plan.host_project_id, store);
        expect(recovered.state).toBe("RECOVERED");
        if (recovered.state === "RECOVERED") expect(recovered.session.receipt.receipt_id).toBe("receipt-local-001");
    });

    test("manifest version/hash drift, wrong project, missing Human confirmation, and blockers are zero-write failures", async () => {
        const plan = cloneFixture();
        const preview = await buildRemotePublishPreview(plan, enabledPolicy());
        const base = {
            userScope: "user-remote-001",
            hostProjectId: plan.host_project_id,
            plan,
            policy: enabledPolicy(),
            humanConfirmed: true,
            confirmationId: "confirm-local-002",
            expectedManifestVersion: preview.manifest_version,
            expectedManifestHash: preview.manifest_hash,
        };
        const cases = [
            { ...base, expectedManifestVersion: 2 },
            { ...base, expectedManifestHash: "f".repeat(64) },
            { ...base, hostProjectId: "another-host-project" },
            { ...base, humanConfirmed: false },
            { ...base, policy: enabledPolicy("REMOTE_AUTHORITY") },
        ];
        for (const input of cases) {
            const store = createMemoryRemoteSyncSessionStore();
            await expect(confirmRemoteSyncPreviewLocally(input, { store, now, createId })).rejects.toThrow();
            expect(store.writeCount).toBe(0);
            expect(await store.read(plan.host_project_id)).toEqual([]);
        }
    });

    test("a recovered session is marked STALE when its stored plan no longer reproduces the receipt hash", async () => {
        const plan = cloneFixture();
        const preview = await buildRemotePublishPreview(plan, enabledPolicy());
        const firstStore = createMemoryRemoteSyncSessionStore();
        const session = await confirmRemoteSyncPreviewLocally(
            {
                userScope: "user-remote-001",
                hostProjectId: plan.host_project_id,
                plan,
                policy: enabledPolicy(),
                humanConfirmed: true,
                confirmationId: "confirm-local-003",
                expectedManifestVersion: preview.manifest_version,
                expectedManifestHash: preview.manifest_hash,
            },
            { store: firstStore, now, createId },
        );
        session.plan.generated_at = "2026-08-28T12:30:00.000Z";
        const driftedStore = createMemoryRemoteSyncSessionStore([session]);

        const recovered = await recoverLatestRemoteSyncSession("user-remote-001", plan.host_project_id, driftedStore);
        expect(recovered.state).toBe("STALE_MANIFEST");
    });

    test("a storage failure cannot be reported as a local receipt", async () => {
        const plan = cloneFixture();
        const preview = await buildRemotePublishPreview(plan, enabledPolicy());
        const store = {
            async read() {
                return [];
            },
            async write() {},
        };
        await expect(
            confirmRemoteSyncPreviewLocally(
                {
                    userScope: "user-remote-001",
                    hostProjectId: plan.host_project_id,
                    plan,
                    policy: enabledPolicy(),
                    humanConfirmed: true,
                    confirmationId: "confirm-local-004",
                    expectedManifestVersion: preview.manifest_version,
                    expectedManifestHash: preview.manifest_hash,
                },
                { store, now, createId },
            ),
        ).rejects.toThrow("未能持久化");
    });
});
