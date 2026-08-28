#!/usr/bin/env python3
from __future__ import annotations

import os
import unittest

from golden_a_real import REQUIRED_D0005_OPERATIONS, FilmCoreHttpClient, MissingCoreOperation, run_real_golden_a


class GoldenARealSidecarPreflightTest(unittest.TestCase):
    def test_current_core_blocks_on_missing_d0005_operations_without_mock_fallback(self) -> None:
        result = run_real_golden_a(python_executable=os.environ.get("FILMOS_CORE_PYTHON"))
        self.assertEqual(result["test_status"], "BLOCKED_MISSING_CORE_OPERATION")
        self.assertEqual(result["sidecar"]["health"], "ok")
        self.assertEqual(result["sidecar"]["database"], "temporary_sqlite_sidecar")
        self.assertEqual(result["external_provider_calls"], 0)
        self.assertFalse(result["prepared"])
        self.assertFalse(result["persisted"])
        self.assertFalse(result["reviewed"])
        self.assertFalse(result["approved"])
        self.assertFalse(result["fallback_mock_used"])
        self.assertIn("POST /formal-records", result["missing_operations"])

    def test_operation_adapter_requires_every_d0005_path(self) -> None:
        client = FilmCoreHttpClient("http://127.0.0.1:1")
        client.operations = lambda: {  # type: ignore[method-assign]
            (method, path): object() for method, path in REQUIRED_D0005_OPERATIONS[:-1]
        }
        with self.assertRaises(MissingCoreOperation) as captured:
            client.require_d0005_operations()
        self.assertEqual(captured.exception.operations, ["POST /continuity/check"])


if __name__ == "__main__":
    unittest.main()
