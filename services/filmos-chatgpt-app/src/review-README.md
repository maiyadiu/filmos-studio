# Review Bus read-only MCP adapter

Set these only after the loopback Review Bus reports healthy:

```text
FILMOS_REVIEW_BUS_READ_ENABLED=true
FILMOS_REVIEW_BUS_BASE_URL=http://127.0.0.1:17920
FILMOS_REVIEW_BUS_AUTH_FILE=<FilmOS Studio Application Support>/review-bus/review-bus.token
```

The adapter registers twelve read-only tools. It has no write, paid, destructive, model API, Cookie, or ChatGPT-token path. The first ChatGPT assessment read leaves Codex text sealed until both independent assessments exist. Writeback is a separate Chrome user-gesture challenge flow.
