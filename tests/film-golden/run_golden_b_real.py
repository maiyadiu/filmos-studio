#!/usr/bin/env python3
from __future__ import annotations

import json

from golden_b_real import run_real_golden_b


if __name__ == "__main__":
    print(json.dumps(run_real_golden_b(), ensure_ascii=False, indent=2))
