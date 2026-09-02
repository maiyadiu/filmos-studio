// Generated from packages/filmos-review-contract/contract.v1.json. Do not edit.
import Foundation

public enum ReviewProtocolContract {
    public static let contractHash = "4af5a8b136b8b84e430cbd4ea4681d3fb32ef4f2eaef4dc6c30ed7c9095f3615"
    public static let lanes = Set(["fast", "core", "architecture"])
    public static let submissionKeys = Set(["submission_id", "project_id", "what_happened", "expected_result", "location", "blocks_work", "captured_at", "risk", "suggested_lane", "allowed_change_scope", "app_build_id", "app_tree", "route", "context_snapshot", "attachment_manifest"])
    public static let submissionRiskKeys = Set(["architecture_gap", "requires_schema_change", "requires_authority_change", "data_loss", "security", "cost", "provider_submit", "migration", "core_state"])
    public static let submissionPrefix = "FILMOS-SUBMISSION"
    public static let submissionIDPattern = "^FILMOS-SUBMISSION-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    public static let issueIDPattern = "^FILMOS-(?:ISSUE|ARCH)-[A-Za-z0-9-]{1,120}$"
    public static let projectIDPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
    public static let errorCodePattern = "^[A-Z0-9_]{1,96}$"
    public static let desktopRequestIDPattern = "^[A-Fa-f0-9-]{36}$"
    public static let desktopActions = ["chatgptHostRequest": ReviewDesktopActionContract(requiredKeys: Set(["action", "requestId", "operation", "payload"]), operations: Set(["publish_context", "publish_handoff"]), maximumPayloadBytes: 262144, timeoutMilliseconds: 15000),
        "reviewIssueRequest": ReviewDesktopActionContract(requiredKeys: Set(["action", "requestId", "payload"]), operations: Set([]), maximumPayloadBytes: 524288, timeoutMilliseconds: 20000),
        "reviewIssueAttachmentRequest": ReviewDesktopActionContract(requiredKeys: Set(["action", "requestId", "submissionId", "payload"]), operations: Set([]), maximumPayloadBytes: 37748736, timeoutMilliseconds: 60000),
        "reviewIssueFinalizeRequest": ReviewDesktopActionContract(requiredKeys: Set(["action", "requestId", "submissionId", "payload"]), operations: Set([]), maximumPayloadBytes: 524288, timeoutMilliseconds: 20000),
        "reviewCenterRequest": ReviewDesktopActionContract(requiredKeys: Set(["action", "requestId", "operation", "payload"]), operations: Set([]), maximumPayloadBytes: 524288, timeoutMilliseconds: 15000)]
}

public struct ReviewDesktopActionContract: Sendable {
    public let requiredKeys: Set<String>
    public let operations: Set<String>
    public let maximumPayloadBytes: Int
    public let timeoutMilliseconds: Int
}
