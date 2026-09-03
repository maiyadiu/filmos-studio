import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    DreaminaCliRuntime,
    type DreaminaQueryTraceEvent,
} from "../src/dreamina-cli-runtime.js";


type StatusQuery = (
    submitId: string,
    signal?: AbortSignal,
    downloadDirectory?: string,
    accountBinding?: string,
) => Promise<{ state: "query"; result: unknown }>;


test("one Dreamina status epoch consumes one CLI result for concurrent readers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamina-query-epoch-"));
    let releaseProcess!: () => void;
    const processBarrier = new Promise<void>((resolve) => { releaseProcess = resolve; });
    let processCalls = 0;
    const trace: DreaminaQueryTraceEvent[] = [];
    const runtime = new DreaminaCliRuntime({
        ownerId: "dreamina-query-epoch-owner",
        stateFile: path.join(root, "runtime.json"),
        ensureReady: async () => undefined,
        discover: async () => ({ installed: true, executable: "dreamina" }),
        runProcess: async () => {
            processCalls += 1;
            await processBarrier;
            return { exitCode: 0, stdout: '{"gen_status":"failed"}', stderr: "" };
        },
        onQueryTrace: (event) => trace.push(event),
    });
    const query = (runtime as unknown as { query: StatusQuery }).query.bind(runtime);
    let first: ReturnType<StatusQuery> | undefined;
    let second: ReturnType<StatusQuery> | undefined;
    try {
        first = query("dreamina-query-epoch-submit");
        second = query("dreamina-query-epoch-submit");
        await new Promise<void>((resolve) => setImmediate(resolve));
        releaseProcess();
        await Promise.all([first, second]);

        assert.equal(processCalls, 1);
        assert.deepEqual(trace.map((event) => event.event), [
            "poll_scheduled",
            "status_started",
            "status_consumed",
            "cli_exit",
            "poll_cancelled",
            "finalize",
        ]);
        assert.equal(new Set(trace.map((event) => event.session_id)).size, 1);
        assert.equal(new Set(trace.map((event) => event.query_epoch)).size, 1);
        const final = trace.at(-1)!;
        assert.equal(final.status_started, 1);
        assert.equal(final.status_consumed, 1);
        assert.equal(final.poll_scheduled, 1);
        assert.equal(final.poll_cancelled, 1);
        assert.equal(final.cli_exit, 1);
        assert.equal(final.finalize, 1);
        assert.equal(final.active_readers, 0);
        assert.equal(final.max_concurrent_readers, 1);
        assert.match(final.submit_id_sha256, /^[a-f0-9]{64}$/);
        assert.equal(JSON.stringify(trace).includes("dreamina-query-epoch-submit"), false);
        console.log("DREAMINA_QUERY_EPOCH_RECEIPT", JSON.stringify({
            status: "PASSED",
            session_id: final.session_id,
            query_epoch: final.query_epoch,
            status_started: final.status_started,
            status_consumed: final.status_consumed,
            poll_scheduled: final.poll_scheduled,
            poll_cancelled: final.poll_cancelled,
            cli_exit: final.cli_exit,
            finalize: final.finalize,
            max_concurrent_readers: final.max_concurrent_readers,
            submit_id_sha256: final.submit_id_sha256,
        }));
    } finally {
        releaseProcess();
        await Promise.allSettled([first, second].filter(Boolean));
        await runtime.dispose();
        await fs.rm(root, { recursive: true, force: true });
    }
});
