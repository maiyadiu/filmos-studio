#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess


REQUIRED_IMPORTS = "import fastapi,httpx,jsonschema,pydantic,pytest,uvicorn"


def main() -> None:
    core_python = os.environ.get("FILMOS_CORE_PYTHON", "").strip()
    test_python = os.environ.get("FILMOS_TEST_PYTHON", "").strip()
    if not core_python or core_python != test_python:
        raise RuntimeError("acceptance runner must bind one Film Core Python to all real Golden checks")
    result = subprocess.run(
        (core_python, "-c", REQUIRED_IMPORTS),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("acceptance-owned Film Core Python dependencies are incomplete")
    print(json.dumps({
        "status": "PASSED",
        "film_core_python": "ACCEPTANCE_OWNED_READY",
        "shared_with_chatgpt_golden": True,
        "dependencies": ["fastapi", "httpx", "jsonschema", "pydantic", "pytest", "uvicorn"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
