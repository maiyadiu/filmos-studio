# FilmOS Tool Contract v1

`contract.v1.json` is the sole source for the Track 14 public read-only tool surface. `npm run generate` produces the TypeScript constant, frozen MCP descriptor snapshot, and OpenAPI 3.1 snapshot; `npm run check` fails when any generated artifact drifts.

The seven reserved write names are compatibility placeholders only. They are deliberately absent from the public tool list.
