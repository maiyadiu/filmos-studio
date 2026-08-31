import Foundation

public enum ReviewBusRuntimeContract {
    public static let loopbackBaseURL = "http://127.0.0.1:17920"
    public static let expectedReviewReadToolCount = 12
    public static let maximumIssueSubmissionBytes = 512 * 1024
    private static let issueSubmissionKeys = Set([
        "project_id", "what_happened", "expected_result", "location",
        "blocks_work", "screenshot_refs", "risk", "issue_id", "evidence_items",
        "app_build_id", "app_tree", "route", "context_snapshot",
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
    public static func isValidIssueSubmission(_ data: Data) -> Bool {
        guard data.count <= maximumIssueSubmissionBytes,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys).isSubset(of: issueSubmissionKeys)
        else { return false }

        guard let rawRisk = object["risk"] else { return true }
        guard let risk = rawRisk as? [String: Any],
              Set(risk.keys).isSubset(of: issueRiskKeys)
        else { return false }
        return risk.values.allSatisfy { $0 is Bool }
    }
}
