#!/usr/bin/env node

import { startMcpServer } from "./mcp-server.js";

// The desktop bundle runs the workbench MCP as a separate production helper.
// Keep this entry isolated from the HTTP/browser host so the helper does not
// pull provider-only dependencies into Codex's stdio process.
await startMcpServer({ surface: "workbench_operator" });
