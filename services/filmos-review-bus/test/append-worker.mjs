import { parentPort, workerData } from "node:worker_threads";

const { ReviewBusStore } = await import(workerData.storeModule);
const store = new ReviewBusStore(workerData.databasePath);
try {
  const current = store.get(workerData.issueId);
  store.append({ issueId: current.issue_id, projectId: current.project_id, lane: current.lane, eventType: "concurrency.probe", actor: workerData.actor, payload: { actor: workerData.actor },
    mutate: (next) => { next.concurrency_probes ??= []; next.concurrency_probes.push(workerData.actor); return next; } });
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
} finally { store.close(); }

