from __future__ import annotations

import os

import uvicorn

from film_production_core.api import create_app


def run() -> None:
    host = os.environ.get("FILMOS_CORE_HOST", "127.0.0.1")
    port = int(os.environ.get("FILMOS_CORE_PORT", "8091"))
    uvicorn.run(create_app(), host=host, port=port)


if __name__ == "__main__":
    run()
