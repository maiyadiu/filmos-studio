# Current Route Map

| Concern | Current source | Decision |
|---|---|---|
| Brain catalogue | `web/src/film/agent/brain-profiles.ts`, `canvas-agent/src/brains/profiles.ts` | Keep six public profiles; hide `human.only` as approval actor. |
| Browser brain execution | `web/src/film/agent/browser-runtime-handler.ts` | Replace inferred channel/model selection with exact binding. |
| Agent execution | `canvas-agent/src/brains/generic-agent-runtime.ts` | Reuse canonical context, session and broker. |
| Generation execution | `web/src/pages/canvas/*generation*`, `web/src/film/providers/provider-runtime.ts` | Adapt existing nodes and provider paths; do not build a second canvas. |
| Lifecycle | `film-core/src/film_production_core/formal_models.py`, `formal_service.py` | Extend immutable evidence under Generation Package/Attempt; Candidate/QC/Approved remain authoritative. |
| Settings | `web/src/pages/settings/index.tsx`, `web/src/stores/use-config-store.ts` | Add three first-class sections backed by one repository. |
