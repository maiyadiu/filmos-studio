from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory

from film_production_core.api import create_app


PLANNED_PATHS: dict[str, dict] = {}


def repository_root() -> Path:
    return Path(__file__).resolve().parents[3]


def exported_openapi() -> dict:
    with TemporaryDirectory(prefix="filmos-core-contract-") as directory:
        app = create_app(Path(directory) / "contract.sqlite")
        contract = app.openapi()
    for path_item in contract["paths"].values():
        for method, operation in path_item.items():
            if method.lower() in {
                "get",
                "put",
                "post",
                "delete",
                "options",
                "head",
                "patch",
                "trace",
            }:
                operation["x-implementation-state"] = "implemented"
    contract["paths"].update(PLANNED_PATHS)
    return contract


def main() -> None:
    target = repository_root() / "film-contracts" / "openapi.json"
    target.write_text(
        json.dumps(exported_openapi(), ensure_ascii=False, indent=2, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
