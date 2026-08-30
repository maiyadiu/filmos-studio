# State Authority Matrix

| State | Authority | Allowed terminal/closure states |
|---|---|---|
| Film Core attempt | Film Core | `prepared`, `authorized`, `submitted`, `running`, `succeeded`, `failed`, `cancelled`, `stale` |
| Provider execution | provider adapter evidence | normalized provider status only; cannot approve Candidate |
| Candidate lifecycle | Film Core | `candidate`, `qc_passed`, `qc_failed`, `approved`, `rejected`, `stale` |
| Catalog validation | immutable receipt | `valid`, `expired`, `account_mismatch`, `descriptor_missing`, `descriptor_changed`, `revoked` |
| Budget reservation | Film Core ledger transaction | `reserved`, `released`, `expired`, `settled`, `revoked`, `binding_rotated` |
| Flova external gate | acceptance state machine | `READY_FOR_USER_AUTHORIZATION`, `PASS_REAL_EXTERNAL`, `BLOCKED_BY_VERIFIED_PROVIDER_CAPABILITY`, `FAIL` |

Provider success imports a Candidate only. Formal approval remains a separate Film Core command.
