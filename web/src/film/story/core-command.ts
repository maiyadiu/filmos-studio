export type FilmCoreScriptLockCommand = Readonly<{
    operationId: "filmScriptVersionLock";
    lockedWrite: Readonly<{
        targetId: null;
        expectedVersion: 0;
        expectedContentHash: string;
    }>;
    decisionWrite: Readonly<{
        targetId: null;
        expectedVersion: 0;
        expectedContentHash: string;
    }>;
    actorKind: "human";
    sourceScriptVersion: Readonly<{
        filmEntityId: string;
        expectedVersion: number;
        expectedContentHash: string;
    }>;
    approvedBy: string;
}>;

export type FilmCoreScriptLockReceipt = Readonly<{
    lockedScriptVersionId: string;
    decisionId: string;
    auditEventIds: readonly string[];
}>;

export interface StoryCoreCommandPort {
    filmScriptVersionLock(command: FilmCoreScriptLockCommand, signal?: AbortSignal): Promise<FilmCoreScriptLockReceipt>;
}

export async function confirmFilmCoreScriptLock(port: StoryCoreCommandPort, command: FilmCoreScriptLockCommand, confirmation: Readonly<{ actorKind: "human" | "agent"; confirmed: boolean }>, signal?: AbortSignal): Promise<FilmCoreScriptLockReceipt> {
    if (confirmation.actorKind !== "human") throw new Error("Agent cannot approve or lock a ScriptVersion");
    if (!confirmation.confirmed) throw new Error("human confirmation is required before Script Lock");
    if (!command.approvedBy.trim()) throw new Error("approvedBy is required for Script Lock");
    return port.filmScriptVersionLock(command, signal);
}
