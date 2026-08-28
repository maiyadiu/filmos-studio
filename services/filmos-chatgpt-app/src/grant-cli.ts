import { resolve } from "node:path";

import { JsonProjectGrantStore } from "./grants.js";

const [command, id, subject = "local-desktop", minutesText = "15"] = process.argv.slice(2);
const localDir = resolve(process.env.FILMOS_CHATGPT_LOCAL_DIR ?? ".local/filmos-chatgpt");
const store = await JsonProjectGrantStore.open(resolve(localDir, "grants.json"));

if (command === "issue") {
  const minutes = Number(minutesText);
  if (!id || !Number.isFinite(minutes)) throw new Error("usage: npm run grant -- issue <project-id> [subject-id] [minutes]");
  const issued = await store.issue(id, subject, minutes * 60_000);
  process.stdout.write(`${JSON.stringify({
    grant_id: issued.grant.grant_id,
    project_id: issued.grant.project_id,
    expires_at: issued.grant.expires_at,
    token: issued.token,
    token_notice: "Shown once. Store in macOS Keychain; do not write to logs or project files.",
  }, null, 2)}\n`);
} else if (command === "revoke") {
  if (!id) throw new Error("usage: npm run grant -- revoke <grant-id>");
  await store.revoke(id);
  process.stdout.write(`${JSON.stringify({ grant_id: id, status: "REVOKED" })}\n`);
} else {
  throw new Error("usage: npm run grant -- <issue|revoke> ...");
}
