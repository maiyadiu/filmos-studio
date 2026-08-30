# ADR-006 Generation Target Guards

Status: Accepted. Attempt, target node, prompt, route, descriptor, project policy, model lock and input authorization hashes are checked at authorization and again at submit. Any mismatch yields STALE or a closed failure.
