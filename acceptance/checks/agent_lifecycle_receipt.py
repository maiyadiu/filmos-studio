#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FIXED_BASELINE = "5cbf078c134cc79cc3d86dde91687a24bd6b0188"
GATES = {
    "AGENT-BROWSER-LIFECYCLE-001": {
        "commands": ((ROOT / "web", ("bun", "test", "test/agent-browser-runtime-lifecycle.test.ts")),),
        "prefix": "FILMOS_AGENT_BROWSER_LIFECYCLE_RECEIPT ",
    },
    "AGENT-CONNECTION-PROBE-ISOLATION-001": {
        "commands": (
            (ROOT / "canvas-agent", ("npx", "tsx", "--test", "--test-concurrency=1", "test/connection-probe-isolation.test.ts")),
            (ROOT / "web", ("bun", "test", "test/agent-browser-runtime-lifecycle.test.ts")),
        ),
        "prefix": "FILMOS_AGENT_CONNECTION_PROBE_RECEIPT ",
        "supplementary": {"browser_probe_matrix": "FILMOS_AGENT_BROWSER_LIFECYCLE_RECEIPT "},
    },
    "CHATGPT-HOST-RESTART-RECOVERY-001": {
        "commands": ((ROOT / "canvas-agent", ("npx", "tsx", "--test", "--test-concurrency=1", "test/chatgpt-host-lifecycle.test.ts")),),
        "prefix": "FILMOS_CHATGPT_HOST_RESTART_RECEIPT ",
    },
    "CHATGPT-HANDOFF-STATE-001": {
        "commands": (
            (ROOT / "canvas-agent", ("npx", "tsx", "--test", "--test-concurrency=1", "test/chatgpt-host-lifecycle.test.ts")),
            (ROOT / "services" / "filmos-chatgpt-app", ("npx", "tsx", "--test", "--test-concurrency=1", "test/live-host-context.test.ts")),
            (ROOT / "web", ("bun", "test", "test/agent-chatgpt-handoff-runtime.test.ts")),
        ),
        "prefix": "FILMOS_CHATGPT_HANDOFF_STATE_RECEIPT ",
        "supplementary": {"real_host_observation": "FILMOS_CHATGPT_REAL_HANDOFF_OBSERVATION_RECEIPT "},
    },
}


def require(condition: bool, code: str) -> None:
    if not condition:
        raise RuntimeError(code)


def main() -> int:
    parser = argparse.ArgumentParser(description="FilmOS final Agent lifecycle receipt")
    parser.add_argument("gate_id", choices=tuple(GATES))
    args = parser.parse_args()
    gate = GATES[args.gate_id]

    ancestry = subprocess.run(("git", "merge-base", "--is-ancestor", FIXED_BASELINE, "HEAD"), cwd=ROOT, check=False)
    require(ancestry.returncode == 0, "FIXED_BASELINE_NOT_ANCESTOR")
    outputs: list[str] = []
    for cwd, command in gate["commands"]:
        result = subprocess.run(command, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        outputs.append(f"$ {' '.join(command)}\n{result.stdout}")
        require(result.returncode == 0, f"{args.gate_id}_TEST_FAILED\n{result.stdout[-12000:]}")
    test_output = "\n".join(outputs)
    lines = [line.split(gate["prefix"], 1)[1] for line in test_output.splitlines() if gate["prefix"] in line]
    require(len(lines) == 1, f"{args.gate_id}_RECEIPT_MISSING_OR_DUPLICATE")
    receipt = json.loads(lines[0])
    require(receipt.get("gate_id") == args.gate_id and receipt.get("status") == "PASSED", f"{args.gate_id}_NOT_PASSED")
    for field, prefix in gate.get("supplementary", {}).items():
        matches = [line.split(prefix, 1)[1] for line in test_output.splitlines() if prefix in line]
        require(len(matches) == 1, f"{args.gate_id}_{field.upper()}_MISSING_OR_DUPLICATE")
        supplemental = json.loads(matches[0])
        require(supplemental.get("status") == "PASSED", f"{args.gate_id}_{field.upper()}_NOT_PASSED")
        receipt[field] = supplemental
    receipt["schema_version"] = "1.0.0"
    receipt["fixed_baseline"] = FIXED_BASELINE
    receipt["test_output_sha256"] = hashlib.sha256(test_output.encode("utf-8")).hexdigest()
    receipt["rc1_tag_created_by_check"] = False
    print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
