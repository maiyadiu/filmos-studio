# Upstream Compatibility Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `.local/acceptance-artifacts/runs/20260831T064657Z-6ea93bfa0838-rc-local/receipt.json`
- Receipt SHA-256: `99ca3581eb9e142ad23bef5a964e903688ebb18c5dd95e5f70f0bcbdfa6fd066`
- Started from Commit: `6ea93bfa08381264a1379fe938ade3a7513c7bba`
- Source snapshot SHA-256: `4cb0029a8826ddbb70698198808de5f094dea9adce3deb2001a35d72f16849e6`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `upstream-compatibility` | `PASSED` | `acceptance/evidence/runs/20260831T064657Z-6ea93bfa0838-rc-local/upstream-compatibility.log` | `4bc16c109a13cf141f74ebc9a58cc364959a3d9e9b74071dddbe602f37ef6107` |
| `rc-recovery` | `PASSED` | `acceptance/evidence/runs/20260831T064657Z-6ea93bfa0838-rc-local/rc-recovery.log` | `906b70a63c741f49df212094efbbefe5a32c7f1d61a6375965a5252eb0be4ee2` |

## Scope and boundary

Pinned upstream compatibility and rollback tests bootstrap the exact frozen commits from the declared public Yingce repository into isolated refs; no pre-existing workstation remote or tracking ref is used. The current candidate classification remains `C_MIGRATION_REQUIRED`; this report does not authorize merge, rebase, push or data migration.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.
