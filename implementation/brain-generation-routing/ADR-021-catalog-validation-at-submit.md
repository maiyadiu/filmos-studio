# ADR-021 Catalog Validation at Submit

Status: Accepted. Catalog validity is checked immediately before authorization/submit and captured in an immutable receipt with `submitNotAfter`. Expiry, account mismatch, revocation or descriptor drift closes submit.
