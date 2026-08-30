# Budget Authority Matrix

| Object/action | Authority | Binding/closure rule |
|---|---|---|
| BudgetGrant | Film Core mutable version | project, currency, provider and allowed binding scope |
| BudgetLedger | Film Core unique mutable aggregate | exact project/currency; optimistic version/hash |
| Reservation | immutable ledger evidence | canonical decimal amount, accountRef, instanceRef, route/attempt IDs |
| LedgerEvent | append-only evidence | reserve/release/expire/settle/adjust/revoke/rotate |
| Reserve/settle | one atomic Film Core transaction | no UI-side balance arithmetic |
| Binding rotation | Film Core command | closes outstanding old-binding reservations as `binding_rotated`; creates no silent rebinding |
| Revocation | Film Core command | closes eligible reservations as `revoked`; submit fails closed |

Numbers are parsed only after lexical validation and compared as fixed-scale decimals.
