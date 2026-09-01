import Foundation

public enum ReviewBusRuntimeContract {
    public static let loopbackBaseURL = "http://127.0.0.1:17920"
    public static let expectedReviewReadToolCount = 12
    public static let maximumIssueSubmissionBytes = 512 * 1024
    private static let submissionKeys = Set([
        "submission_id", "project_id", "what_happened", "expected_result", "location",
        "blocks_work", "captured_at", "risk", "suggested_lane", "allowed_change_scope",
        "app_build_id", "app_tree", "route", "context_snapshot", "attachment_manifest",
    ])
    private static let issueRiskKeys = Set([
        "architecture_gap", "requires_schema_change", "requires_authority_change",
        "data_loss", "security", "cost", "provider_submit", "migration", "core_state",
    ])
    // The governance task packet freezes this base independently from the
    // packaged App's source commit. Candidate A and B must remain descendants
    // of the same review base across App rebuilds.
    public static let fixedBaseCommit = "ecfc79a9b9f7e91cdfd558747fdc5d2b62e1700a"

    public static func canonicalDirectory(applicationRuntimeRoot: URL) -> URL {
        applicationRuntimeRoot
            .deletingLastPathComponent()
            .appendingPathComponent("FilmOS Studio", isDirectory: true)
            .appendingPathComponent("review-bus", isDirectory: true)
    }

    public static func developerRepositoryDirectory(applicationRuntimeRoot: URL) -> URL {
        canonicalDirectory(applicationRuntimeRoot: applicationRuntimeRoot)
            .deletingLastPathComponent()
            .appendingPathComponent("DeveloperRepository", isDirectory: true)
            .appendingPathComponent("filmos-studio", isDirectory: true)
    }

    public static func reviewWorktreeDirectory(applicationRuntimeRoot: URL) -> URL {
        canonicalDirectory(applicationRuntimeRoot: applicationRuntimeRoot)
            .appendingPathComponent("worktrees", isDirectory: true)
    }

    public static func chatGPTReadEnvironment(
        reviewBusDirectory: URL,
        healthURL: URL = URL(string: "http://127.0.0.1:17920/healthz")!
    ) -> [String: String] {
        let baseURL = healthURL.deletingLastPathComponent().absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return [
            "FILMOS_REVIEW_BUS_READ_ENABLED": "true",
            "FILMOS_REVIEW_BUS_BASE_URL": baseURL,
            "FILMOS_REVIEW_BUS_AUTH_FILE": reviewBusDirectory.appendingPathComponent("review-bus.token").path,
        ]
    }

    /// Keeps the Web-to-native intake contract aligned with the Review Bus.
    /// Lane selection remains Review Bus authority; Web may only submit bounded
    /// boolean risk evidence for that authority to classify.
    public static func isValidSubmission(_ data: Data) -> Bool {
        guard data.count <= maximumIssueSubmissionBytes,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == submissionKeys,
              let submissionID = object["submission_id"] as? String,
              submissionID.range(of: "^FILMOS-SUBMISSION-[a-f0-9-]{36}$", options: .regularExpression) != nil,
              let projectID = object["project_id"] as? String,
              projectID.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", options: .regularExpression) != nil,
              let whatHappened = object["what_happened"] as? String, !whatHappened.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, whatHappened.count <= 4_000,
              let expectedResult = object["expected_result"] as? String, !expectedResult.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, expectedResult.count <= 4_000,
              let location = object["location"] as? String, !location.isEmpty, location.count <= 2_048,
              object["blocks_work"] is Bool,
              let capturedAt = object["captured_at"] as? String, isValidTimestamp(capturedAt),
              let allowedScope = object["allowed_change_scope"] as? [String], allowedScope.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.count <= 512 }),
              let attachmentManifest = object["attachment_manifest"] as? [[String: Any]], attachmentManifest.count <= 5,
              attachmentManifest.allSatisfy(isValidAttachmentManifestEntry),
              isNullOrBoundedString(object["app_build_id"], maximum: 160, pattern: "^[A-Za-z0-9._-]{1,160}$"),
              isNullOrBoundedString(object["app_tree"], maximum: 64, pattern: "^[a-f0-9]{40,64}$"),
              isNullOrBoundedString(object["route"], maximum: 2_048),
              object["context_snapshot"] is [String: Any] || object["context_snapshot"] is NSNull,
              object["suggested_lane"] is NSNull || ["fast", "core", "architecture"].contains(object["suggested_lane"] as? String)
        else { return false }

        guard let rawRisk = object["risk"] else { return true }
        guard let risk = rawRisk as? [String: Any],
              Set(risk.keys).isSubset(of: issueRiskKeys)
        else { return false }
        return risk.values.allSatisfy { $0 is Bool }
    }

    private static func isValidAttachmentManifestEntry(_ value: [String: Any]) -> Bool {
        guard Set(value.keys) == Set(["attachment_id", "media_type", "original_name", "size_bytes", "sha256", "captured_at"]),
              let attachmentID = value["attachment_id"] as? String,
              attachmentID.range(of: "^attachment-[A-Za-z0-9-]{1,120}$", options: .regularExpression) != nil,
              let mediaType = value["media_type"] as? String,
              mediaType.range(of: "^(?:image|video)/[A-Za-z0-9.+-]{1,80}$|^(?:text/plain|application/json)$", options: .regularExpression) != nil,
              let name = value["original_name"] as? String, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.count <= 255,
              let size = value["size_bytes"] as? Int, size > 0, size <= 25 * 1024 * 1024,
              let digest = value["sha256"] as? String, digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let capturedAt = value["captured_at"] as? String, isValidTimestamp(capturedAt)
        else { return false }
        return true
    }

    private static func isNullOrBoundedString(_ value: Any?, maximum: Int, pattern: String? = nil) -> Bool {
        if value is NSNull { return true }
        guard let value = value as? String, !value.isEmpty, value.count <= maximum else { return false }
        return pattern == nil || value.range(of: pattern!, options: .regularExpression) != nil
    }

    private static func isValidTimestamp(_ value: String) -> Bool {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) != nil || ISO8601DateFormatter().date(from: value) != nil
    }

    public static func isValidSubmissionFinalize(_ data: Data) -> Bool {
        guard data.count <= maximumIssueSubmissionBytes,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["project_id", "capture_hash"]),
              object["project_id"] is String,
              let captureHash = object["capture_hash"] as? String,
              captureHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
        else { return false }
        return true
    }

    public static func isValidStagedAttachment(_ data: Data) -> Bool {
        guard data.count <= 36 * 1024 * 1024,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["attachment_id", "media_type", "original_name", "size_bytes", "sha256", "base64", "captured_at"]),
              let attachmentID = object["attachment_id"] as? String,
              attachmentID.range(of: "^attachment-[A-Za-z0-9-]{1,120}$", options: .regularExpression) != nil,
              let mediaType = object["media_type"] as? String,
              mediaType.range(of: "^(?:image|video)/[A-Za-z0-9.+-]{1,80}$|^(?:text/plain|application/json)$", options: .regularExpression) != nil,
              let name = object["original_name"] as? String, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.count <= 255,
              let size = object["size_bytes"] as? Int, size > 0, size <= 25 * 1024 * 1024,
              let digest = object["sha256"] as? String, digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let base64 = object["base64"] as? String, !base64.isEmpty, base64.count <= 35_000_000,
              let capturedAt = object["captured_at"] as? String, isValidTimestamp(capturedAt)
        else { return false }
        return true
    }
}
