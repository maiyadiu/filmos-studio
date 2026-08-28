#!/usr/bin/env python3
from __future__ import annotations

import json
import os

from golden_a_real import run_real_golden_a


if __name__ == "__main__":
    result = run_real_golden_a(python_executable=os.environ.get("FILMOS_CORE_PYTHON"))
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
