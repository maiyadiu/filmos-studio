# FilmOS Review Bus

Local-only Developer Governance for use-driven dual-expert review. It is deliberately outside Film Core. The database is SQLite with WAL, immutable events, mutable projections, and one-time bridge challenges. No endpoint performs creative writes, Provider submissions, uploads, external-project creation, or model API calls.

Runtime: **Node.js >= 24.10.0**; CI pins Node 26.3.0. `external-read` depends on Node's `DatabaseSync.setAuthorizer` and SQLite authorization constants. The capability check fails before opening any database; it must not fall back to an unguarded connection. The source helper runs this service with Node, not Bun.

`npm test` uses fixture/temporary databases. A normal `npm start` is **not a read-only diagnostic**: it may initialize schema, pairing files and runtime observations in the configured local store. Do not use the default Production directory as an ordinary test fixture. Assessment-seal and external-read keep their existing frozen identity/policy contracts; changing the runtime prerequisite does not authorize starting them.

```bash
FILMOS_REVIEW_BUS_TOKEN='<local-pairing-secret>' npm start
npm test
```

Default data: `~/Library/Application Support/FilmOS Studio/review-bus/review-bus.sqlite`.
Default listener: `127.0.0.1:17920`. Requests require the local bearer pairing secret; `/healthz` is non-sensitive. The Chrome bridge must obtain a fresh challenge after an explicit click. Revocation invalidates the current pairing hash and all unused challenges.

After revocation, create a new one-time Chrome pairing token and restart the helper:

```bash
npm run rotate-bridge-token
```

The command prints the new token once for the Chrome extension options page. It does not reuse the revoked value.
