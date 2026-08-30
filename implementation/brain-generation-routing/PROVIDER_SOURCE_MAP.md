# Provider Source Map

| Engine | Current source | Integration |
|---|---|---|
| Dreamina CLI | `web/src/services/local-dreamina-*`, Canvas Agent local runtime | Extend catalogue/receipt around existing submit. |
| Flova CLI | no verified provider source at baseline | F0 read-only verification first; never fabricate availability. |
| RunningHub | `use-config-store.ts`, existing API channel | Wrap existing connection/workflow path. |
| ComfyUI | `use-config-store.ts`, existing bridge | Wrap existing bridge/workflow path. |
| Manual Web | `web/src/film/providers/provider-runtime.ts` | Preserve manual handoff/import path. |

Provider adapters map inputs and status only. Film Core owns Attempt, Candidate, QC and Approved.
