import { describe, expect, test } from "bun:test";

import { CANONICAL_GENERATION_TOOL_NAMES, executeCanonicalGenerationTool } from "../src/film/generation-routing/canonical-tool-runtime";
import { defaultConfig } from "../src/stores/use-config-store";

const context = {
    projectId: "project-test",
    config: structuredClone(defaultConfig),
    routingConfig: null,
    snapshot: { revision: 1, nodes: [], connections: [], selectedNodeIds: [] },
};

describe("canonical generation tool runtime", () => {
    test("all 18 canonical names terminate without unsupported fallback", async () => {
        const inputs: Record<string, Record<string, unknown>> = {
            generation_get_engine_status: { engineId: "dreamina_cli" },
            generation_refresh_catalog: { engineId: "dreamina_cli", connectionId: "dreamina-local" },
            generation_list_models: {}, generation_list_workflows: {}, generation_list_skills: {},
            generation_select_effective_route: { taskKind: "text_to_image" },
            generation_resolve_route_binding: { engineId: "dreamina_cli", connectionId: "dreamina-local", descriptorId: "missing" },
            generation_compile_prompt: { projectId: "project-test", taskKind: "text_to_image", input: { engineId: "dreamina_cli", prompt: "test prompt" } },
            generation_preview_submission: { routeSnapshotId: "route-test" },
            generation_create_external_project: { engineId: "flova_cli", connectionId: "flova-local", input: {} },
            generation_submit: { authorizedSubmissionId: "submission-test" },
            generation_get_status: { taskId: "task-test" }, generation_reconcile: { taskId: "task-test" },
            generation_cancel: { taskId: "task-test" }, generation_download_outputs: { taskId: "task-test" },
            generation_import_candidate: { taskId: "task-test" }, generation_get_lineage: { generationAttemptId: "attempt-test" },
        };
        for (const name of CANONICAL_GENERATION_TOOL_NAMES) {
            const result = await executeCanonicalGenerationTool(name, inputs[name] || {}, context);
            expect(result.message).not.toContain("不支持的工具");
            if (!result.ok) expect(result.data).toMatchObject({ externalWritePerformed: false });
        }
    });

    test("preview is zero-cost and paid submit fails closed without authorization evidence", async () => {
        const preview = await executeCanonicalGenerationTool("generation_preview_submission", { routeSnapshotId: "route-test" }, context);
        expect(preview).toMatchObject({ ok: true, data: { externalCostMicrounits: "0", externalWritePerformed: false } });
        const submit = await executeCanonicalGenerationTool("generation_submit", { authorizedSubmissionId: "submission-test" }, context);
        expect(submit).toMatchObject({ ok: false, data: { code: "AUTHORIZED_GENERATION_SUBMISSION_REQUIRED", externalWritePerformed: false } });
    });
});
