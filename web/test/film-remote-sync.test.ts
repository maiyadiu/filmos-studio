import { describe, expect, test } from "bun:test";

import { buildRemotePublishPreview, createRemoteSyncPolicy, DEFAULT_REMOTE_SYNC_POLICY, type FormalFilmReference, type RemotePublishPlanInput } from "../src/film/sync";

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
        invalidHost.remote_results![0].candidate_ref.host_ref.opaque_id = "";
        await expect(buildRemotePublishPreview(invalidHost, enabledPolicy())).rejects.toThrow("Host opaque ID");
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
