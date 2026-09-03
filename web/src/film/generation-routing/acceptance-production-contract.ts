import type {
    BudgetLedger,
    GenerationBudgetGrant,
    GenerationCatalogSnapshot,
    GenerationEngineConnection,
    ProjectGenerationLock,
    ProjectGenerationPolicy,
} from "@filmos/generation-contracts";


export type AcceptanceMockBindings = {
    connection: GenerationEngineConnection;
    catalog: GenerationCatalogSnapshot;
    projectPolicy: ProjectGenerationPolicy;
    projectLock: ProjectGenerationLock;
    grant: GenerationBudgetGrant;
    ledger: BudgetLedger;
};
