import Foundation

public enum ReviewBusRuntimeContract {
    public static let loopbackBaseURL = "http://127.0.0.1:17920"
    public static let expectedReviewReadToolCount = 12
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
}
