# Identity Pseudonymization

Stable business records store a pseudonymous binding reference, never an account name, email, token, local path or provider cookie. The reference is derived inside a controlled scope from provider/connection/account/instance identifiers and a non-exported salt. Rotation creates a new reference and append-only `binding_rotated` evidence; revocation creates `revoked` evidence. Cross-project correlation is prevented by scope-specific aliases. User ZIPs contain package aliases only and never the alias mapping.
