import { parentPort, workerData } from "node:worker_threads";

const input = workerData ?? JSON.parse(process.env.FILMOS_APPEND_WORKER_DATA ?? "{}");
const { ReviewBusStore } = await import(input.storeModule);
const store = new ReviewBusStore(input.databasePath);
try {
  if (input.startAt) await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, input.startAt - Date.now())));
  let result;
  if (input.mode === "assessment") {
    const { ReviewBusService } = await import(input.serviceModule);
    const service = new ReviewBusService(store, { baseCommit: input.baseCommit, taskPackageContentHash: input.taskPackageContentHash });
    const value = service.submitAssessment(input.issueId, input.actor, input.assessment, new Date(input.now));
    result = { operation_receipt: value.operation_receipt, idempotent_replay: value.idempotent_replay };
  } else {
    const current = store.get(input.issueId);
    store.append({ issueId: current.issue_id, projectId: current.project_id, lane: current.lane, eventType: "concurrency.probe", actor: input.actor, payload: { actor: input.actor },
      mutate: (next) => { next.concurrency_probes ??= []; next.concurrency_probes.push(input.actor); return next; } });
    result = null;
  }
  respond({ ok: true, result });
} catch (error) {
  respond({ ok: false, error: error.message, code: error.code ?? null });
} finally { store.close(); }

function respond(message) {
  if (parentPort) parentPort.postMessage(message);
  else process.stdout.write(`${JSON.stringify(message)}\n`);
}
