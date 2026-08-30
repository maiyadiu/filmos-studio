# Migration Impact

- Existing projects remain readable; new versioned objects are additive.
- Existing Canvas nodes retain IDs and media paths; generation drafts gain route references without rewriting old results.
- Existing channels, RunningHub, ComfyUI and Dreamina configuration are adapted, not copied.
- Legacy global `textModel` remains a normal text default but is no longer an Agent runtime binding.
- Ambiguous legacy brain mappings are preserved and marked for configuration.
- Downgrade reads backups and old project fields; it does not delete V2.4 snapshots.
- Catalog cache may be purged without losing resolved receipts or project reproducibility.
