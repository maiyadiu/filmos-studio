# ADR-022 Budget Binding Rotation

Status: Accepted. Account/instance rotation is explicit and append-only. Old-binding reservations close as `binding_rotated`; revocation closes as `revoked`. Neither operation silently rebinds authorized work.
