# Config Precedence Matrix

| Decision | Highest to lowest |
|---|---|
| Brain profile selection | explicit task override -> project policy -> global default -> built-in `codex.subscription` |
| Brain runtime binding | exact selected profile binding only; no cross-profile fallback |
| Generation route | explicit draft -> project task-kind route -> global task-kind route -> engine manual fallback if explicitly selected |
| Model/workflow/skill | exact descriptor IDs from selected catalog snapshot/receipt; no name or URL guessing |
| Secret | exact binding reference -> secure runtime lookup; never config-string inference |

Selection of a profile and resolution of its binding are separate operations. Missing/invalid bindings fail closed with `NEEDS_CONFIGURATION`.
