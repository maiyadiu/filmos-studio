#!/usr/bin/env python3
from __future__ import annotations

import json

from golden_a_mock import run_golden_a


if __name__ == "__main__":
    result = run_golden_a()
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
