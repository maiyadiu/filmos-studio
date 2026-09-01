import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { isExecutedAsMain, startFromEnvironment } from "../src/server.js";

test("server entrypoint recognizes decoded paths containing spaces and Unicode", () => {
  const rawPath = "/tmp/短剧/FilmOS Studio/dist/server.js";
  assert.equal(isExecutedAsMain(pathToFileURL(rawPath).href, rawPath), true);
  assert.equal(isExecutedAsMain(pathToFileURL(rawPath).href, "/tmp/other/server.js"), false);
  assert.equal(isExecutedAsMain(pathToFileURL(rawPath).href, undefined), false);
});

test("server PID receipt is written only after listen and removed on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "filmos-chatgpt-pid-"));
  const pidFile = join(directory, "chatgpt-mcp.pid");
  try {
    const started = await startFromEnvironment({
      FILMOS_CHATGPT_APP_ENABLED: "true",
      FILMOS_CHATGPT_HOST: "127.0.0.1",
      FILMOS_CHATGPT_PORT: "0",
      FILMOS_CHATGPT_LOCAL_DIR: directory,
      FILMOS_CHATGPT_PID_FILE: pidFile,
    });
    assert.equal((await readFile(pidFile, "utf8")).trim(), String(process.pid));
    await new Promise<void>((resolveClose, rejectClose) => started.httpServer.close((error) => error ? rejectClose(error) : resolveClose()));
    await assert.rejects(stat(pidFile), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
