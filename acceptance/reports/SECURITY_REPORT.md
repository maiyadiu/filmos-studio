# Security Report

- Evidence status: `DEVELOPMENT_EVIDENCE_DIRTY`
- Receipt: `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/receipt.json`
- Receipt SHA-256: `f5b3e9b24e8088f9529d8e2205c92a5f2eefbab7bf4757eda4e9007a675dc1b7`
- Started from Commit: `bdec33ced224ea3aedc984aad426d1c20c9fc4f7`
- Source snapshot SHA-256: `64a65f6fda5367ae874c6d6323f12e0c89efa2e33bb5566aa7d56b7bc8a547fa`

## Machine evidence

| Check | Status | Raw log | SHA-256 |
| --- | --- | --- | --- |
| `desktop-local-auth` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/desktop-local-auth.log` | `137fcdeb49b0fb797238e08683c3229a0c3be3f87bbb1a8e6eb9be0298827fbf` |
| `desktop-backup-restore` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/desktop-backup-restore.log` | `b2d2f16782af6cd4d468c620a14620eea74efbb151ec815420aa0a0840695fb5` |
| `canvas-agent` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/canvas-agent.log` | `ef9f9f4e1e1c0f6e3f80429b2a5d535c00f05e5c6be449383b5161369acb8681` |
| `chatgpt-handoff-local` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/chatgpt-handoff-local.log` | `8186097952bc512b01be57984b953022531e6583fbeb0e0f1342509751292752` |
| `chatgpt-golden-real` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/chatgpt-golden-real.log` | `b858fd3a20ca4b634506c8d12120e4c0a908800ea36b82dfd957f922f3e78227` |
| `desktop-chatgpt-connection` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/desktop-chatgpt-connection.log` | `380d6d7ee57e015f65e5bbb65b7459bd95c2a93ea09631e58a932c7efafe70f4` |
| `no-openai-model-api-billing` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/no-openai-model-api-billing.log` | `fdf14aa2cda0a10642df9d6b61bac61d1e821f67da2a5eb070e1b8ccf30fb256` |
| `acceptance-privacy` | `PASSED` | `acceptance/evidence/runs/20260829T094648Z-bdec33ced224-rc-local/acceptance-privacy.log` | `94659353861841ef97a7c57073b514920872baa269e5b655753e83b0534e0e64` |

## Scope and boundary

The covered checks enforce loopback-only desktop auth, human-only approval, credential exclusion from backup/evidence, ChatGPT preview boundaries and a redacted evidence package. Runtime Key is Keychain-only, Tunnel and ChatGPT reachability remain separate states, and model API endpoint use is blocked. Passing local checks does not prove public deployment security or Apple notarization.

This report is an evidence view, not an independent pass declaration. The raw receipt and logs above are authoritative.
