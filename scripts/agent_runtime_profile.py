#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import shlex
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROFILE_FILE = ROOT / "config" / "agent-runtime-profiles.json"
FLAG_IDS = (
    "film.agent_native_brain_selector",
    "film.agent_generic_runtime",
    "film.agent_context_broker",
    "film.agent_canonical_tool_manifest",
    "film.agent_canonical_tool_broker",
    "film.agent_codex_subscription",
    "film.agent_chatgpt_host",
    "film.agent_model_api_profiles",
    "film.agent_no_silent_api_fallback",
    "film.agent_request_scoped_identity",
)
RUNTIME_ENV = {
    "film.agent_native_brain_selector": "FILMOS_AGENT_NATIVE_BRAIN_SELECTOR",
    "film.agent_generic_runtime": "FILMOS_AGENT_GENERIC_RUNTIME",
    "film.agent_context_broker": "FILMOS_AGENT_CONTEXT_BROKER",
    "film.agent_canonical_tool_manifest": "FILMOS_AGENT_CANONICAL_TOOL_MANIFEST",
    "film.agent_canonical_tool_broker": "FILMOS_AGENT_CANONICAL_TOOL_BROKER",
    "film.agent_codex_subscription": "FILMOS_AGENT_CODEX_SUBSCRIPTION",
    "film.agent_chatgpt_host": "FILMOS_AGENT_CHATGPT_HOST",
    "film.agent_model_api_profiles": "FILMOS_AGENT_MODEL_API_PROFILES",
    "film.agent_no_silent_api_fallback": "FILMOS_AGENT_NO_SILENT_API_FALLBACK",
    "film.agent_request_scoped_identity": "FILMOS_AGENT_REQUEST_SCOPED_IDENTITY",
}
VITE_ENV = {
    "film.agent_native_brain_selector": "VITE_FILM_AGENT_NATIVE_BRAIN_SELECTOR",
    "film.agent_generic_runtime": "VITE_FILM_AGENT_GENERIC_RUNTIME",
    "film.agent_context_broker": "VITE_FILM_AGENT_CONTEXT_BROKER",
    "film.agent_canonical_tool_manifest": "VITE_FILM_AGENT_CANONICAL_TOOL_MANIFEST",
    "film.agent_canonical_tool_broker": "VITE_FILM_AGENT_CANONICAL_TOOL_BROKER",
    "film.agent_codex_subscription": "VITE_FILM_AGENT_CODEX_SUBSCRIPTION",
    "film.agent_chatgpt_host": "VITE_FILM_AGENT_CHATGPT_HOST",
    "film.agent_model_api_profiles": "VITE_FILM_AGENT_MODEL_API_PROFILES",
    "film.agent_no_silent_api_fallback": "VITE_FILM_AGENT_NO_SILENT_API_FALLBACK",
    "film.agent_request_scoped_identity": "VITE_FILM_AGENT_REQUEST_SCOPED_IDENTITY",
}


class ProfileError(RuntimeError):
    pass


def load_profile(profile_id: str) -> dict[str, bool]:
    try:
        document = json.loads(PROFILE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProfileError("Agent runtime profile contract is unreadable") from error
    if document.get("schema_version") != 1 or not isinstance(document.get("profiles"), dict):
        raise ProfileError("Agent runtime profile schema is unsupported")
    profile = document["profiles"].get(profile_id)
    flags = profile.get("flags") if isinstance(profile, dict) else None
    if not isinstance(flags, dict) or set(flags) != set(FLAG_IDS):
        raise ProfileError(f"Agent runtime profile {profile_id!r} must define exactly ten flags")
    if any(type(flags[flag]) is not bool for flag in FLAG_IDS):
        raise ProfileError(f"Agent runtime profile {profile_id!r} contains a non-boolean flag")
    expected = profile_id == "filmos-candidate"
    if profile_id not in {"integration", "filmos-candidate"} or any(flags[flag] is not expected for flag in FLAG_IDS):
        raise ProfileError(f"Agent runtime profile {profile_id!r} is not an atomic activation profile")
    return {flag: flags[flag] for flag in FLAG_IDS}


def flags_hash(flags: dict[str, bool]) -> str:
    canonical = "".join(f"{flag}={'true' if flags[flag] else 'false'}\n" for flag in sorted(flags))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def shell(profile_id: str, flags: dict[str, bool]) -> str:
    values = {
        "FILMOS_AGENT_RUNTIME_PROFILE": profile_id,
        "FILMOS_AGENT_FEATURE_FLAGS_HASH": flags_hash(flags),
        "FILMOS_AGENT_GATEWAY_ENABLED": "true" if profile_id == "filmos-candidate" else "false",
        "VITE_FILMOS_AGENT_RUNTIME_PROFILE": profile_id,
        "VITE_FILMOS_AGENT_FEATURE_FLAGS_HASH": flags_hash(flags),
    }
    for flag in FLAG_IDS:
        value = "true" if flags[flag] else "false"
        values[RUNTIME_ENV[flag]] = value
        values[VITE_ENV[flag]] = value
    return "\n".join(f"export {key}={shlex.quote(value)}" for key, value in values.items()) + "\n"


def runtime_document(args: argparse.Namespace, profile_id: str, flags: dict[str, bool]) -> dict[str, object]:
    required = {
        "start_url": args.start_url,
        "web_health_url": args.web_health_url,
        "backend_health_url": args.backend_health_url,
        "application_support_directory_name": args.application_support_directory_name,
        "backend_data_directory_name": args.backend_data_directory_name,
    }
    if any(not isinstance(value, str) or not value for value in required.values()):
        raise ProfileError("Desktop runtime document arguments are incomplete")
    return {
        "schema_version": 2,
        **required,
        "agent_runtime_profile": profile_id,
        "agent_feature_flags": flags,
        "agent_feature_flags_hash": flags_hash(flags),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("shell", "inspect", "runtime"))
    parser.add_argument("--profile", required=True)
    parser.add_argument("--output")
    parser.add_argument("--start-url")
    parser.add_argument("--web-health-url")
    parser.add_argument("--backend-health-url")
    parser.add_argument("--application-support-directory-name")
    parser.add_argument("--backend-data-directory-name", default="WorkbenchData")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    flags = load_profile(args.profile)
    if args.command == "shell":
        print(shell(args.profile, flags), end="")
        return 0
    if args.command == "inspect":
        print(json.dumps({
            "profile_id": args.profile,
            "feature_flag_count": len(flags),
            "feature_flags": flags,
            "feature_flags_hash": flags_hash(flags),
            "atomic": True,
        }, ensure_ascii=False, sort_keys=True))
        return 0
    if not args.output:
        raise ProfileError("--output is required for runtime")
    output = Path(args.output)
    output.write_text(json.dumps(runtime_document(args, args.profile, flags), ensure_ascii=False, sort_keys=True), encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ProfileError as error:
        print(f"AGENT_RUNTIME_PROFILE_ERROR {error}")
        raise SystemExit(1)
