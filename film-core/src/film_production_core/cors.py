from __future__ import annotations

import ipaddress
import os
from collections.abc import Collection
from urllib.parse import urlsplit

from starlette.middleware.cors import CORSMiddleware
from starlette.types import ASGIApp


CORS_ORIGINS_ENV = "FILMOS_CORE_CORS_ORIGINS"
CORS_METHODS = ("GET", "POST", "PUT", "OPTIONS")
CORS_HEADERS = ("Accept", "Content-Type")


def is_loopback_http_origin(origin: str) -> bool:
    try:
        parsed = urlsplit(origin)
        port = parsed.port
        host = parsed.hostname
    except ValueError:
        return False
    if (
        parsed.scheme != "http"
        or host is None
        or port is None
        or not 1 <= port <= 65535
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        return False
    if host in {"localhost", "127.0.0.1"}:
        return True
    try:
        return ipaddress.IPv6Address(host) == ipaddress.IPv6Address("::1")
    except ipaddress.AddressValueError:
        return False


def configured_cors_origins() -> frozenset[str] | None:
    raw = os.environ.get(CORS_ORIGINS_ENV)
    if raw is None or not raw.strip():
        return None
    origins = frozenset(item.strip() for item in raw.split(",") if item.strip())
    invalid = sorted(
        origin for origin in origins if not is_loopback_http_origin(origin)
    )
    if invalid:
        raise ValueError(
            f"{CORS_ORIGINS_ENV} accepts only explicit loopback HTTP origins: "
            + ", ".join(invalid)
        )
    return origins


class LoopbackCORSMiddleware(CORSMiddleware):
    def __init__(
        self,
        app: ASGIApp,
        *,
        exact_origins: Collection[str] | None = None,
    ) -> None:
        self.exact_origins = (
            None if exact_origins is None else frozenset(exact_origins)
        )
        super().__init__(
            app,
            allow_origins=tuple(self.exact_origins or ()),
            allow_methods=CORS_METHODS,
            allow_headers=CORS_HEADERS,
            allow_credentials=False,
        )

    def is_allowed_origin(self, origin: str) -> bool:
        if self.exact_origins is not None:
            return origin in self.exact_origins
        return is_loopback_http_origin(origin)
