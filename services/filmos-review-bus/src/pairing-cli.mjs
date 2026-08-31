#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const localDir = resolve(process.env.FILMOS_REVIEW_BUS_LOCAL_DIR ?? resolve(homedir(), "Library/Application Support/FilmOS Studio/review-bus"));
const destination = resolve(localDir, "review-bridge.token");
const temporary = `${destination}.new`;
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
const token = randomBytes(36).toString("base64url");
writeFileSync(temporary, `${token}\n`, { mode: 0o600 });
renameSync(temporary, destination);
chmodSync(destination, 0o600);
process.stdout.write(`${JSON.stringify({ rotated: true, restart_review_bus_required: true, bridge_token: token })}\n`);
