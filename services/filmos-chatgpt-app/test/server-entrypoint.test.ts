import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { isExecutedAsMain } from "../src/server.js";

test("server entrypoint recognizes decoded paths containing spaces and Unicode", () => {
  const rawPath = "/tmp/短剧/FilmOS Studio/dist/server.js";
  assert.equal(isExecutedAsMain(pathToFileURL(rawPath).href, rawPath), true);
  assert.equal(isExecutedAsMain(pathToFileURL(rawPath).href, "/tmp/other/server.js"), false);
  assert.equal(isExecutedAsMain(pathToFileURL(rawPath).href, undefined), false);
});
