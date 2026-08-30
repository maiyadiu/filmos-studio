# Catalog Validation Authority

Catalog snapshots are account-scoped ephemeral cache. A resolved descriptor receipt copies the exact canonical descriptor blob and its semantic/envelope hashes into the Generation Package. Immediately before authorization/submit, the runtime validates engine, connection, pseudonymous account/instance binding, descriptor ID/version/blob hash, capabilities, revocation and expiry. The immutable CatalogValidationReceipt binds route hash, descriptor hashes, validation time and `submitNotAfter`.

Submit accepts only the descriptor blob embedded in the validated receipt. Display labels, list indexes, fuzzy matches, current cache entries and provider URLs are never selection keys.
