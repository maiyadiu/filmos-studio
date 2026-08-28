from __future__ import annotations

import argparse

import uvicorn
from fastapi import FastAPI

from film_production_core.api import create_app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--port", required=True, type=int)
    args = parser.parse_args()
    app = FastAPI()
    app.mount("/film", create_app(args.database))
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=args.port,
        log_level="warning",
        access_log=False,
    )


if __name__ == "__main__":
    main()
