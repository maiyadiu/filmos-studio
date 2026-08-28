# FilmOS ChatGPT App

Private, loopback-only Track 14 MCP service. It exposes a Project Grant scoped, read-only FilmOS surface plus optional signed proposal handoff. It never registers the reserved write tools.

```bash
npm install
npm run build
FILMOS_CHATGPT_LOCAL_DIR=.local/filmos-chatgpt npm run grant -- issue <host-project-id> local-desktop 15
FILMOS_CHATGPT_APP_ENABLED=true \
FILMOS_CHATGPT_READ_TOOLS_ENABLED=true \
FILMOS_CHATGPT_WIDGETS_ENABLED=true \
npm start
npm run doctor
```

The grant command shows the bearer token once and persists only its SHA-256 hash in a mode-0600 file. The desktop bridge is responsible for storing the raw token in Keychain. Set `FILMOS_CHATGPT_PROPOSAL_HANDOFF_ENABLED=true` and inject a local signing secret of at least 32 characters only when proposal export has been explicitly enabled.

`npm test` reaches validation level 2: contract generation/compile, a real local streamable HTTP MCP client/server loop, tools/resources, authorization, proposal export, security, media, feature gates, compatibility, and disconnect behavior. `FILMOS_TEST_PYTHON=/path/to/film-core-venv/bin/python npm run test:golden-real` additionally starts a temporary real Film Core SQLite/HTTP service, reads a real Candidate chain through MCP and widgets, exports a real file, and invokes the Python Preview importer twice for idempotency.

Local desktop/Web handoff endpoints are Project Grant protected:

- `GET /handoff/status?project_id=...` returns connection/grant summary without token or local paths;
- `POST /handoff/grants/revoke` revokes only the bearer Grant;
- `POST /handoff/proposals/preview` accepts exactly `{ "package": ... }` and directly returns the Film Core Preview wrapper.

See `使用与恢复.md` for recovery and fail-closed drills. This implementation does not connect an OpenAI account, ChatGPT Developer Mode, or a real Secure MCP Tunnel.
