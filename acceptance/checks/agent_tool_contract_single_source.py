#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "packages" / "filmos-agent-tool-contracts"


def require(condition: bool, code: str) -> None:
    if not condition:
        raise RuntimeError(code)


def main() -> int:
    subprocess.run(("npm", "run", "check"), cwd=PACKAGE, check=True)
    subprocess.run(("npm", "test"), cwd=PACKAGE, check=True)
    contract_path = PACKAGE / "generated" / "canonical-tools.json"
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    tools = contract["tools"]
    require(tools, "CANONICAL_AGENT_TOOL_CONTRACT_EMPTY")
    require(len({tool["name"] for tool in tools}) == len(tools), "CANONICAL_AGENT_TOOL_NAME_DUPLICATE")
    require(all(len(tool["input_schema_hash"]) == 64 for tool in tools), "CANONICAL_AGENT_TOOL_SCHEMA_HASH_MISSING")
    require(all("x-filmos-validator" not in tool["input_schema"] for tool in tools), "CANONICAL_AGENT_TOOL_SCHEMA_PLACEHOLDER_PRESENT")
    web_source = (ROOT / "web/src/film/agent/model-api-tool-manifest.ts").read_text(encoding="utf-8")
    require("canonicalModelApiToolManifest" in web_source, "WEB_MODEL_API_GENERATED_CONTRACT_NOT_CONSUMED")
    runtime_source = (ROOT / "canvas-agent/src/brains/tool-manifest.ts").read_text(encoding="utf-8")
    require("canonicalAgentToolsByName" in runtime_source, "RUNTIME_GENERATED_CONTRACT_NOT_CONSUMED")
    mcp_source = (ROOT / "canvas-agent/src/mcp-server.ts").read_text(encoding="utf-8")
    require("canonicalMcpTools" in mcp_source, "MCP_GENERATED_CONTRACT_NOT_CONSUMED")
    receipt = {
        "schema_version": "1.0.0",
        "gate_id": "AGENT-TOOL-CONTRACT-SINGLE-SOURCE-001",
        "status": "PASSED",
        "contract_hash": contract["contract_hash"],
        "contract_file_sha256": hashlib.sha256(contract_path.read_bytes()).hexdigest(),
        "tool_count": len(tools),
        "schema_hash_count": len({tool["input_schema_hash"] for tool in tools}),
        "consumers": ["runtime", "mcp", "model_api", "local_model"],
        "source_contracts": contract["source_contracts"],
    }
    print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
