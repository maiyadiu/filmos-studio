# Upstream Compatibility Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `.local/acceptance-artifacts/runs/20260830T164746Z-b12b1ba108a9-rc-local/receipt.json`
- Receipt SHA-256: `0de021df68ebb75e42c702771480aeddd49566bc6f454bdd4356d295a2a50b43`
- Started from Commit: `b12b1ba108a926470614b2e6a231d333d1a1d00f`
- Source snapshot SHA-256: `d0888cb19b878a71e66299c50abb50c94303be14c4fa42720d754bf832338050`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `upstream-compatibility` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/upstream-compatibility.log` | `e79751f67e0885e12abc15002b662fd3a2d675f834e3af415e1bd82ecb3634cc` |
| `rc-recovery` | `PASSED` | `acceptance/evidence/runs/20260830T164746Z-b12b1ba108a9-rc-local/rc-recovery.log` | `d2b445a31a9e4ce0eaf8c4d43d02ba1f73a0ecbd07b80f024037d82977a02923` |

## Scope and boundary

Pinned upstream compatibility and rollback tests bootstrap the exact frozen commits from the declared public Yingce repository into isolated refs; no pre-existing workstation remote or tracking ref is used. The current candidate classification remains `C_MIGRATION_REQUIRED`; this report does not authorize merge, rebase, push or data migration.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.
