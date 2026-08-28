from __future__ import annotations

import argparse
import json
import os
import sys

from .proposal_import import FilmOSProposalImportError, JsonProposalImportReceiptStore, import_proposal_file


def main() -> None:
    parser = argparse.ArgumentParser(description="FilmOS external-brain proposal adapter")
    commands = parser.add_subparsers(dest="command", required=True)
    preview_parser = commands.add_parser("preview", help="validate and create a local import preview only")
    preview_parser.add_argument("path")
    preview_parser.add_argument("--project-id", required=True)
    preview_parser.add_argument("--state-hash", required=True)
    preview_parser.add_argument("--versions-json", default="{}")
    preview_parser.add_argument("--receipt-file", required=True)
    args = parser.parse_args()
    secret = os.environ.get("FILMOS_CHATGPT_PROPOSAL_SIGNING_SECRET", "")
    try:
        preview = import_proposal_file(
            args.path,
            signing_secret=secret,
            expected_project_id=args.project_id,
            current_state_hash=args.state_hash,
            current_versions=json.loads(args.versions_json),
            receipts=JsonProposalImportReceiptStore(args.receipt_file),
        )
        print(json.dumps({"ok": True, "kind": "FILMOS_PROPOSAL_IMPORT_PREVIEW", "preview": preview.to_dict()}, ensure_ascii=False, indent=2))
    except FilmOSProposalImportError as error:
        print(json.dumps({"ok": False, "kind": "FILMOS_PROPOSAL_IMPORT_REJECTED", "code": error.code, "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2) from error


if __name__ == "__main__":
    main()
