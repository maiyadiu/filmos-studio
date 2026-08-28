import {
  approveCandidateAssetBinding,
  approvedBindingLockReference,
  createCandidateAssetBinding,
  createVisualLockSet,
  type ApprovedAssetBinding,
  type AssetBindingTarget,
  type BindingPurpose,
  type FilmAssetSemantic,
} from "../../web/src/film/assets/asset-layer";

type BindingSeed = Readonly<{
  bindingId: string;
  candidateId: string;
  candidateAuditEventId: string;
  approvalAuditEventId: string;
  reviewId: string;
  qcReportId: string;
  role: string;
  semantic: FilmAssetSemantic;
  purpose: BindingPurpose;
  target: AssetBindingTarget;
  hostAssetId: string;
  hostAssetVersionId: string;
  hostResourceId: string;
  contentHash: string;
}>;

type GoldenBAssetInput = Readonly<{
  hostProjectId: string;
  bindings: readonly BindingSeed[];
  previousRoles: Readonly<Record<string, string>>;
  nextRoles: Readonly<Record<string, string>>;
  previousVisualLockId: string;
  nextVisualLockId: string;
  scopeId: string;
  occurredAt: string;
}>;

const raw = await Bun.stdin.text();
const input = JSON.parse(raw) as GoldenBAssetInput;
const approved = new Map<string, ApprovedAssetBinding>();
const auditIds: string[] = [];

for (const seed of input.bindings) {
  const candidate = await createCandidateAssetBinding(
    {
      id: seed.candidateId,
      auditEventId: seed.candidateAuditEventId,
      hostProjectId: input.hostProjectId,
      target: seed.target,
      purpose: seed.purpose,
      createdAt: input.occurredAt,
      createdBy: "golden-b-asset-preparer",
      asset: {
        schemaVersion: 1,
        semantic: seed.semantic,
        host: {
          hostAssetId: seed.hostAssetId,
          hostAssetVersionId: seed.hostAssetVersionId,
          hostResourceId: seed.hostResourceId,
          contentHash: seed.contentHash,
        },
        media: { kind: "host_resource", hostResourceId: seed.hostResourceId },
        integrity: {
          state: "verified",
          observedContentHash: seed.contentHash,
          verifiedAt: input.occurredAt,
        },
        authorization: {
          state: "verified",
          evidenceId: `authorization-${seed.role}`,
          scope: "Golden B local fixture only",
        },
        provenance: {
          kind: "manual_import",
          sourceReceiptId: `receipt-${seed.role}`,
        },
      },
    },
    { enabled: true },
  );
  const result = await approveCandidateAssetBinding(
    candidate.binding,
    {
      approvedBindingId: seed.bindingId,
      auditEventId: seed.approvalAuditEventId,
      expectedVersion: candidate.binding.version,
      reviewId: seed.reviewId,
      qcReportId: seed.qcReportId,
      qcOutcome: "pass",
      actorId: "golden-b-asset-director",
      approvedAt: input.occurredAt,
    },
    { enabled: true },
  );
  approved.set(seed.bindingId, result.binding);
  auditIds.push(candidate.audit.id, result.audit.id);
}

const previous = await createVisualLockSet(
  {
    id: input.previousVisualLockId,
    scopeId: input.scopeId,
    version: 1,
    createdAt: input.occurredAt,
    components: { referenceRoleMap: roleMap(input.previousRoles) },
  },
  { enabled: true },
);
const next = await createVisualLockSet(
  {
    id: input.nextVisualLockId,
    scopeId: input.scopeId,
    version: 2,
    createdAt: input.occurredAt,
    components: { referenceRoleMap: roleMap(input.nextRoles) },
  },
  { enabled: true },
);

process.stdout.write(
  JSON.stringify({
    goldenId: "GOLDEN-B-ASSETS-LOCAL",
    prepared: true,
    formalApply: false,
    externalProviderCalls: 0,
    approvedBindings: [...approved.values()],
    approvalAuditIds: auditIds,
    previousVisualLock: previous,
    nextVisualLock: next,
  }),
);

function roleMap(roles: Readonly<Record<string, string>>) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(roles).map(([role, bindingId]) => {
        const binding = approved.get(bindingId);
        if (!binding) throw new Error(`Unknown approved binding for role ${role}`);
        return [role, approvedBindingLockReference(binding)];
      }),
    ),
  );
}
