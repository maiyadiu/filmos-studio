# Upstream Compatibility Report

- Evidence status: `CLEAN_LOCAL_EVIDENCE_NOT_FROZEN`
- Receipt: `.local/acceptance-artifacts/runs/20260830T165124Z-a45effee4fe2-rc-local/receipt.json`
- Receipt SHA-256: `5981dc29ba5859699790a97890d1de40fdeb58572b44b239a0b5585789f15cb1`
- Started from Commit: `a45effee4fe282db80f444cb18500533e270178f`
- Source snapshot SHA-256: `4c45dfa7bf9e23947df9dd5136b0dcc038ec43bdea07e83e4720dc4c1f26b30b`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `upstream-compatibility` | `PASSED` | `.local/acceptance-artifacts/runs/20260830T165124Z-a45effee4fe2-rc-local/upstream-compatibility.log` | `aa8c50a0ec59c1cfe7726b1c84ccf449342dc965f30a0ac517bf009444cf128d` |
| `rc-recovery` | `PASSED` | `.local/acceptance-artifacts/runs/20260830T165124Z-a45effee4fe2-rc-local/rc-recovery.log` | `4d10195df20c559b23c2725dfd976a3fa4e5199a4ea499ae6a36de02b37c60ec` |

## Scope and boundary

Pinned upstream compatibility and rollback tests bootstrap the exact frozen commits from the declared public Yingce repository into isolated refs; no pre-existing workstation remote or tracking ref is used. The current candidate classification remains `C_MIGRATION_REQUIRED`; this report does not authorize merge, rebase, push or data migration.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.
