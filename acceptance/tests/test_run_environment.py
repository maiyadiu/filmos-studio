from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

import pytest


RUN_PATH = Path(__file__).resolve().parents[1] / "run.py"
SPEC = importlib.util.spec_from_file_location("filmos_acceptance_run", RUN_PATH)
assert SPEC is not None and SPEC.loader is not None
acceptance_run = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = acceptance_run
SPEC.loader.exec_module(acceptance_run)


def make_interpreter(root: Path) -> Path:
    interpreter = root / ".local" / "acceptance-venv" / "bin" / "python"
    interpreter.parent.mkdir(parents=True)
    interpreter.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    interpreter.chmod(0o755)
    return interpreter


def test_uses_only_absolute_interpreter_from_current_clone(tmp_path: Path) -> None:
    root = tmp_path / "FilmOS 工作区 with spaces"
    expected = make_interpreter(root)

    selected = acceptance_run.resolve_film_core_python({}, root=root, probe=False)

    assert selected == str(expected.absolute())


@pytest.mark.parametrize("variable", ["FILMOS_CORE_PYTHON", "FILMOS_TEST_PYTHON"])
def test_rejects_external_or_relative_ambient_interpreter(tmp_path: Path, variable: str) -> None:
    root = tmp_path / "FilmOS 工作区"
    make_interpreter(root)
    for invalid in ("python3", "/usr/bin/python3", str(tmp_path / "other" / "python")):
        with pytest.raises(acceptance_run.FilmCorePythonError) as caught:
            acceptance_run.resolve_film_core_python(
                {variable: invalid},
                root=root,
                probe=False,
            )
        assert caught.value.code == "FILMOS_CORE_PYTHON_INVALID"


def test_rejects_conflicting_core_and_test_interpreters(tmp_path: Path) -> None:
    root = tmp_path / "FilmOS 工作区"
    expected = make_interpreter(root)

    with pytest.raises(acceptance_run.FilmCorePythonError) as caught:
        acceptance_run.resolve_film_core_python(
            {
                "FILMOS_CORE_PYTHON": str(expected.absolute()),
                "FILMOS_TEST_PYTHON": "/usr/bin/python3",
            },
            root=root,
            probe=False,
        )

    assert caught.value.code == "FILMOS_CORE_PYTHON_INVALID"


def test_missing_clone_interpreter_fails_without_system_fallback(tmp_path: Path) -> None:
    root = tmp_path / "FilmOS 工作区"

    with pytest.raises(acceptance_run.FilmCorePythonError) as caught:
        acceptance_run.resolve_film_core_python({}, root=root, probe=False)

    assert caught.value.code == "FILMOS_CORE_PYTHON_UNAVAILABLE"


def test_acceptance_environment_binds_both_variables_to_clone(monkeypatch: pytest.MonkeyPatch) -> None:
    expected = str(acceptance_run.clone_film_core_python())
    monkeypatch.delenv("FILMOS_CORE_PYTHON", raising=False)
    monkeypatch.delenv("FILMOS_TEST_PYTHON", raising=False)

    environment, ready = acceptance_run.acceptance_environment()

    assert ready is True
    assert environment["FILMOS_CORE_PYTHON"] == expected
    assert environment["FILMOS_TEST_PYTHON"] == expected
    assert Path(environment["FILMOS_CORE_PYTHON"]).is_absolute()
    assert os.path.normpath(environment["FILMOS_CORE_PYTHON"]) == expected
