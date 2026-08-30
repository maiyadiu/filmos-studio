# Persistence Ownership Matrix

| Object | Class | Sole authority | Projection/cache |
|---|---|---|---|
| BrainProfileBinding | MUTABLE_AUTHORITY | Desktop local user-config repository | Zustand UI cache |
| ProjectBrainPolicy | MUTABLE_AUTHORITY | Film Core project version | UI cache |
| EngineConnectionMetadata | MUTABLE_AUTHORITY | Desktop/local connection repository | UI cache |
| ProjectGenerationPolicy, ModelLock, BudgetGrant | MUTABLE_AUTHORITY | Film Core | UI cache |
| BudgetLedger | MUTABLE_AUTHORITY | Film Core, one ledger per project/currency | UI read projection |
| NodeGenerationDraft | MUTABLE_AUTHORITY | Canvas Project Data | Canvas store projection |
| Route/Descriptor/CatalogValidation/Authorization/Submission snapshots | IMMUTABLE_BUSINESS_SNAPSHOT | Film Core Generation Package/Attempt | read projection |
| BudgetReservation/LedgerEvent | IMMUTABLE_BUSINESS_SNAPSHOT | Film Core append-only store | timeline projection |
| RedactionReceipt | IMMUTABLE_BUSINESS_SNAPSHOT | controlled Acceptance artifact | convenience ZIP copy |
| CatalogSnapshot | EPHEMERAL_CACHE | account-scoped local runtime cache | UI search cache |
| API/runtime/CLI secret | SECRET_EXTERNAL | Keychain/backend/CLI store | opaque ref only |
| Settings screens | UI_PROJECTION | none | render repository state |

Duplicate authorities: 0. Ordinary `localStorage` is not authoritative for any listed business record.
