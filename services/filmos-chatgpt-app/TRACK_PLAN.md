# Track 14 | FilmOS ChatGPT App

## Classification and boundaries

- Primary archetype: `interactive-decoupled`.
- FilmOS data tools and explicit render tools are separate. Widgets use the MCP Apps bridge first; `window.openai` is additive fallback only.
- `film.chatgpt_app=false` and `film.chatgpt_proposal_handoff=false` are the formal defaults requested from Program Integration.
- The server binds loopback only. No public listener, tunnel, ChatGPT account, API key, upload, publication, provider generation, Approval, Lock, Apply, paid task, or deletion is created by this Track.
- ChatGPT text and project text are untrusted inputs. Film Core remains the formal fact source; imported packages stop at Proposal, Candidate, or Review Draft preview.

## Official capability check

| Surface | Status | Local decision |
| --- | --- | --- |
| MCP server / streamable HTTP `/mcp` | BUILD | TypeScript SDK, stable tool contract, short Project Grant sessions |
| MCP Apps UI | BUILD | Seven versioned widget resources, exact empty CSP domain lists |
| Standard `search` / `fetch` | BUILD | Exact one-text-item JSON shape |
| OAuth 2.1 | DEFER | Current local candidate uses explicit short Project Grant; production identity provider is not authorized |
| Secure MCP Tunnel | EXTEND | Outbound-only doctor/config adapter; actual Platform tunnel id and runtime key are external blockers |
| ChatGPT Developer Mode | UNVERIFIED | No real account or host loop was authorized in this run |
| Public submission | DEFER | Private candidate only; no public endpoint or review metadata publication |
| Tool snapshot refresh | BUILD | One JSON source generates TypeScript, MCP, and OpenAPI snapshots with hash checks |

Official sources checked before implementation:

- https://developers.openai.com/plugins/build/mcp-server
- https://developers.openai.com/plugins/build/chatgpt-ui
- https://developers.openai.com/plugins/build/examples
- https://developers.openai.com/plugins/plan/tools
- https://developers.openai.com/plugins/reference
- https://developers.openai.com/plugins/build/app-quickstart
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://developers.openai.com/plugins/guides/security-privacy
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

The closest maintained starting pattern is the official single-resource TypeScript quickstart, adapted to the repository-owned split service plus portable MCP Apps bridge. The implementation uses `@modelcontextprotocol/sdk` streamable HTTP directly because authorization is Project Grant scoped and data/render tools are decoupled; no floating example repository source was copied.

## Day 1-5 delivery map

1. Day 1: contract source/generator, standard search/fetch, FilmOS read client, feature flags, contract tests.
2. Day 2: loopback MCP, Project Grant, short sessions, audit, desktop Keychain adapter, tunnel fail-closed doctor, Golden A.
3. Day 3: seven widgets, media proxy boundary, no-media fallback, synthetic Candidate fixture plus real Film Core read client.
4. Day 4: signed `.filmosproposal`, desktop document contract, FilmOS adapter Preview, conflict and idempotency, Golden B.
5. Day 5: prompt injection, scope isolation, tunnel disconnect, snapshot compatibility, recovery, plugin validation, candidate and recovery docs.

## Evidence language

Local MCP and synthetic Candidate tests may be reported as `PASSED_LOCAL`. Secure Tunnel and actual ChatGPT host connection must remain `BLOCKED_EXTERNAL_ACCOUNT`; local MCP runtime tests are not ChatGPT connection evidence.
