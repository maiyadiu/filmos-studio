export class CodexReviewWatcher {
  constructor({ baseUrl, token, projectId, intervalMs = 2_000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.projectId = projectId;
    this.intervalMs = Math.max(250, intervalMs);
    this.fetchImpl = fetchImpl;
    this.lastHashes = new Map();
  }

  async poll(signal) {
    const url = new URL("/v1/review/pending", this.baseUrl);
    url.searchParams.set("project_id", this.projectId);
    const response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.token}` }, signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.code ?? "REVIEW_WATCH_FAILED");
    const changed = body.issues.filter((issue) => this.lastHashes.get(issue.issue_id) !== issue.content_hash);
    for (const issue of body.issues) this.lastHashes.set(issue.issue_id, issue.content_hash);
    return changed;
  }

  async watch(onChange, signal) {
    while (!signal?.aborted) {
      for (const issue of await this.poll(signal)) await onChange(issue);
      await delay(this.intervalMs, signal);
    }
  }
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("ABORTED")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
