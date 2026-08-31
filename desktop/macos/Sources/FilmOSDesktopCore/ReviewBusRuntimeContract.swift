import Foundation

public enum ReviewBusRuntimeContract {
    public static let loopbackBaseURL = "http://127.0.0.1:17920"
    public static let expectedReviewReadToolCount = 12

    public static func canonicalDirectory(applicationRuntimeRoot: URL) -> URL {
        applicationRuntimeRoot
            .deletingLastPathComponent()
            .appendingPathComponent("FilmOS Studio", isDirectory: true)
            .appendingPathComponent("review-bus", isDirectory: true)
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
