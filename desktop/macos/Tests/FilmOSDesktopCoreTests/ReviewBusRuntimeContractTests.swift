import Foundation
import Testing

@testable import FilmOSDesktopCore

struct ReviewBusRuntimeContractTests {
    @Test
    func candidateGovernanceBaseDoesNotDriftWithAppRebuilds() {
        #expect(ReviewBusRuntimeContract.fixedBaseCommit == "ecfc79a9b9f7e91cdfd558747fdc5d2b62e1700a")
    }

    @Test
    func pilotBusinessRootStillUsesTheSingleGovernanceRoot() {
        let pilotRuntimeRoot = URL(fileURLWithPath: "/Users/example/Library/Application Support/FilmOS Studio Pilot", isDirectory: true)
        let reviewRoot = ReviewBusRuntimeContract.canonicalDirectory(applicationRuntimeRoot: pilotRuntimeRoot)
        #expect(reviewRoot.path == "/Users/example/Library/Application Support/FilmOS Studio/review-bus")
    }

    @Test
    func reviewCodexUsesCanonicalInternalRepositoryAndIsolatedWorktrees() {
        let pilotRuntimeRoot = URL(fileURLWithPath: "/Users/example/Library/Application Support/FilmOS Studio Pilot", isDirectory: true)
        let repository = ReviewBusRuntimeContract.developerRepositoryDirectory(applicationRuntimeRoot: pilotRuntimeRoot)
        let worktrees = ReviewBusRuntimeContract.reviewWorktreeDirectory(applicationRuntimeRoot: pilotRuntimeRoot)
        #expect(repository.path == "/Users/example/Library/Application Support/FilmOS Studio/DeveloperRepository/filmos-studio")
        #expect(worktrees.path == "/Users/example/Library/Application Support/FilmOS Studio/review-bus/worktrees")
    }

    @Test
    func chatGPTMCPReceivesReadOnlyReviewBusContract() {
        let root = URL(fileURLWithPath: "/tmp/FilmOS Studio/review-bus", isDirectory: true)
        let environment = ReviewBusRuntimeContract.chatGPTReadEnvironment(reviewBusDirectory: root)
        #expect(environment["FILMOS_REVIEW_BUS_READ_ENABLED"] == "true")
        #expect(environment["FILMOS_REVIEW_BUS_BASE_URL"] == "http://127.0.0.1:17920")
        #expect(environment["FILMOS_REVIEW_BUS_AUTH_FILE"] == "/tmp/FilmOS Studio/review-bus/review-bus.token")
        #expect(ReviewBusRuntimeContract.expectedReviewReadToolCount == 12)

        let alternate = ReviewBusRuntimeContract.chatGPTReadEnvironment(
            reviewBusDirectory: root,
            healthURL: URL(string: "http://127.0.0.1:19020/healthz")!
        )
        #expect(alternate["FILMOS_REVIEW_BUS_BASE_URL"] == "http://127.0.0.1:19020")
    }

    @Test
    func nativeSubmissionBridgeAcceptsTheExactStagedIntakeContract() throws {
        let payload: [String: Any] = [
            "submission_id": "FILMOS-SUBMISSION-b3274782-30a0-44a1-a05e-01730678da8b",
            "project_id": "project-1",
            "what_happened": "Candidate A failed before ChatGPT Findings writeback",
            "expected_result": "Candidate B must pass with dual signoff",
            "location": "agent:/canvas/project-1",
            "blocks_work": true,
            "captured_at": "2026-09-01T16:16:00.955Z",
            "risk": ["core_state": true],
            "suggested_lane": "core",
            "allowed_change_scope": [],
            "app_build_id": NSNull(),
            "app_tree": NSNull(),
            "route": "/canvas/project-1",
            "context_snapshot": ["selectedNodeIds": []],
            "attachment_manifest": [],
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        #expect(ReviewBusRuntimeContract.isValidSubmission(data))
        let finalize = try JSONSerialization.data(withJSONObject: ["project_id": "project-1", "capture_hash": String(repeating: "a", count: 64)])
        #expect(ReviewBusRuntimeContract.isValidSubmissionFinalize(finalize))
        let attachment = try JSONSerialization.data(withJSONObject: [
            "attachment_id": "attachment-stage-a-1",
            "media_type": "image/png",
            "original_name": "反馈截图.png",
            "size_bytes": 5,
            "sha256": String(repeating: "b", count: 64),
            "base64": "aW1hZ2U=",
            "captured_at": "2026-09-01T16:16:00.955Z",
        ])
        #expect(ReviewBusRuntimeContract.isValidStagedAttachment(attachment))
    }

    @Test
    func nativeIssueBridgeRejectsClientLaneAndUnboundedRiskShape() throws {
        let clientLane = try JSONSerialization.data(withJSONObject: [
            "project_id": "project-1",
            "lane": "fast",
        ])
        #expect(!ReviewBusRuntimeContract.isValidSubmission(clientLane))

        let unknownRisk = try JSONSerialization.data(withJSONObject: [
            "project_id": "project-1",
            "risk": ["arbitrary": true],
        ])
        #expect(!ReviewBusRuntimeContract.isValidSubmission(unknownRisk))

        let nonBooleanRisk = try JSONSerialization.data(withJSONObject: [
            "project_id": "project-1",
            "risk": ["core_state": "yes"],
        ])
        #expect(!ReviewBusRuntimeContract.isValidSubmission(nonBooleanRisk))
    }
}
