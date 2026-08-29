"""Self-contained loopback Film Core used by the FilmOS desktop connection manager."""

from __future__ import annotations

import os

import uvicorn
from fastapi import FastAPI

from film_production_core.api import create_app


def build_app() -> FastAPI:
    database_path = os.environ["FILMOS_CORE_DB_PATH"]
    app = FastAPI(title="FilmOS Desktop Film Core")
    core = create_app(database_path)

    @app.get("/health")
    def health() -> dict[str, object]:
        return {"ok": True, "service": "filmos-film-core", "mounted_base": "/film"}

    app.mount("/film", core)
    return app


def main() -> None:
    uvicorn.run(
        build_app(),
        host=os.environ.get("FILMOS_CORE_HOST", "127.0.0.1"),
        port=int(os.environ.get("FILMOS_CORE_PORT", "17650")),
        log_level="warning",
    )


if __name__ == "__main__":
    main()
