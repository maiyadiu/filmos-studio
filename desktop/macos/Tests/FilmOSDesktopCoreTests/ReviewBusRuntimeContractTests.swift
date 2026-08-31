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
}
