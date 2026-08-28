import Foundation
import Testing

@testable import FilmOSDesktopCore

@Suite
struct ProposalHandoffTests {
    @Test
    func cliPreviewUsesFixedPreviewCommandKeychainSecretAndControlledReceipt() async throws {
        let sandbox = try makeSandbox()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let filmCoreApp = sandbox.appendingPathComponent("film-core-app", isDirectory: true)
        let receipts = sandbox.appendingPathComponent("receipts", isDirectory: true)
        try FileManager.default.createDirectory(at: filmCoreApp, withIntermediateDirectories: true)
        let proposal = sandbox.appendingPathComponent("candidate.filmosproposal")
        try Data("{}".utf8).write(to: proposal)

        let response = Data(#"{"ok":true,"kind":"FILMOS_PROPOSAL_IMPORT_PREVIEW","preview":{"status":"PREVIEW_REQUIRES_HUMAN_APPROVAL","formal_write_executed":false,"local_path":"/Users/private/project","token_value":"must-not-render"}}"#.utf8)
        let executor = CapturingProcessExecutor(result: ProcessExecutionResult(
            terminationStatus: 0,
            standardOutput: response,
            standardError: Data()
        ))
        let tokens = MemorySecureTokenStore()
        try tokens.store("01234567890123456789012345678901", for: .proposalSigningSecret)
        let previewer = FilmCoreCLIProposalPreviewer(
            configuration: FilmCoreCLIPreviewConfiguration(
                pythonExecutableURL: URL(fileURLWithPath: "/usr/bin/python3"),
                filmCoreAppURL: filmCoreApp,
                receiptDirectoryURL: receipts
            ),
            tokenStore: tokens,
            processExecutor: executor,
            makeReceiptID: { "receipt-001" }
        )
        let context = FilmCoreProposalPreviewContext(
            projectID: "10000000-0000-4000-8000-000000000001",
            stateHash: String(repeating: "a", count: 64),
            versionsByEntityURI: ["filmos://shot/shot-a": 7]
        )

        let preview = try await previewer.preview(fileURL: proposal, context: context)
        let invocation = try #require(await executor.invocation)
        let stagedProposalPath = receipts.appendingPathComponent("proposal-input-receipt-001.filmosproposal").path
        #expect(invocation.arguments == [
            "-m", "external_brains.chatgpt.cli", "preview", stagedProposalPath,
            "--project-id", context.projectID,
            "--state-hash", context.stateHash,
            "--versions-json", #"{"filmos:\/\/shot\/shot-a":7}"#,
            "--receipt-file", receipts.appendingPathComponent("proposal-preview-receipt-001.json").path,
        ])
        #expect(!invocation.arguments.contains("apply"))
        #expect(!FileManager.default.fileExists(atPath: stagedProposalPath))
        #expect(!invocation.arguments.contains("01234567890123456789012345678901"))
        #expect(invocation.environment["FILMOS_CHATGPT_PROPOSAL_SIGNING_SECRET"] == "01234567890123456789012345678901")
        #expect(invocation.environment["PYTHONPATH"] == filmCoreApp.path)
        #expect(preview.status == "PREVIEW_REQUIRES_HUMAN_APPROVAL")
        #expect(!preview.formalWriteExecuted)
        #expect(preview.receiptURL.path.hasPrefix(receipts.path + "/"))
        let display = try #require(String(data: preview.displayJSON, encoding: .utf8))
        #expect(!display.contains("/Users/private/project"))
        #expect(!display.contains("must-not-render"))
        #expect(display.contains("<redacted-local-path>"))
        #expect(display.contains("<redacted>"))
    }

    @Test
    func cliRejectionIsReturnedWithoutAnyApplyFallback() async throws {
        let sandbox = try makeSandbox()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let filmCoreApp = sandbox.appendingPathComponent("film-core-app", isDirectory: true)
        try FileManager.default.createDirectory(at: filmCoreApp, withIntermediateDirectories: true)
        let executor = CapturingProcessExecutor(result: ProcessExecutionResult(
            terminationStatus: 2,
            standardOutput: Data(),
            standardError: Data(#"{"ok":false,"kind":"FILMOS_PROPOSAL_IMPORT_REJECTED","code":"state_hash_conflict","message":"Project state changed"}"#.utf8)
        ), writeReceipt: false)
        let tokens = MemorySecureTokenStore()
        try tokens.store("01234567890123456789012345678901", for: .proposalSigningSecret)
        let proposal = sandbox.appendingPathComponent("proposal.filmosproposal")
        try Data("{}".utf8).write(to: proposal)
        let previewer = FilmCoreCLIProposalPreviewer(
            configuration: FilmCoreCLIPreviewConfiguration(
                pythonExecutableURL: URL(fileURLWithPath: "/usr/bin/python3"),
                filmCoreAppURL: filmCoreApp,
                receiptDirectoryURL: sandbox.appendingPathComponent("receipts")
            ),
            tokenStore: tokens,
            processExecutor: executor,
            makeReceiptID: { "rejected" }
        )

        await #expect(throws: ProposalHandoffError.importRejected(
            code: "state_hash_conflict",
            message: "Project state changed"
        )) {
            try await previewer.preview(
                fileURL: proposal,
                context: FilmCoreProposalPreviewContext(projectID: "project", stateHash: "hash", versionsByEntityURI: [:])
            )
        }
        let invocation = try #require(await executor.invocation)
        #expect(invocation.arguments.filter { $0 == "preview" }.count == 1)
        #expect(!invocation.arguments.contains("apply"))
    }

    @Test
    func rejectsAnyResponseThatClaimsFormalWrite() async throws {
        let sandbox = try makeSandbox()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let filmCoreApp = sandbox.appendingPathComponent("film-core-app", isDirectory: true)
        try FileManager.default.createDirectory(at: filmCoreApp, withIntermediateDirectories: true)
        let response = Data(#"{"ok":true,"kind":"FILMOS_PROPOSAL_IMPORT_PREVIEW","preview":{"status":"PREVIEW_REQUIRES_HUMAN_APPROVAL","formal_write_executed":true}}"#.utf8)
        let executor = CapturingProcessExecutor(result: ProcessExecutionResult(
            terminationStatus: 0,
            standardOutput: response,
            standardError: Data()
        ))
        let tokens = MemorySecureTokenStore()
        try tokens.store("01234567890123456789012345678901", for: .proposalSigningSecret)
        let proposal = sandbox.appendingPathComponent("proposal.filmosproposal")
        try Data("{}".utf8).write(to: proposal)
        let previewer = FilmCoreCLIProposalPreviewer(
            configuration: FilmCoreCLIPreviewConfiguration(
                pythonExecutableURL: URL(fileURLWithPath: "/usr/bin/python3"),
                filmCoreAppURL: filmCoreApp,
                receiptDirectoryURL: sandbox.appendingPathComponent("receipts")
            ),
            tokenStore: tokens,
            processExecutor: executor,
            makeReceiptID: { "unsafe" }
        )

        await #expect(throws: ProposalHandoffError.unsafePreviewResponse) {
            try await previewer.preview(
                fileURL: proposal,
                context: FilmCoreProposalPreviewContext(projectID: "project", stateHash: "hash", versionsByEntityURI: [:])
            )
        }
    }

    @Test
    func fileOpenCoordinatorEnforcesCoreOneMiBLimitAndExtension() async throws {
        let sandbox = try makeSandbox()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let result = FilmCoreProposalPreview(
            kind: "FILMOS_PROPOSAL_IMPORT_PREVIEW",
            status: "PREVIEW_REQUIRES_HUMAN_APPROVAL",
            formalWriteExecuted: false,
            receiptURL: sandbox.appendingPathComponent("receipt.json"),
            displayJSON: Data("{}".utf8)
        )
        let previewer = CapturingProposalPreviewer(result: result)
        let coordinator = ProposalFileOpenCoordinator(previewer: previewer)
        let context = FilmCoreProposalPreviewContext(projectID: "project", stateHash: "hash", versionsByEntityURI: [:])
        let valid = sandbox.appendingPathComponent("valid.filmosproposal")
        try Data("{}".utf8).write(to: valid)

        #expect(try await coordinator.open(valid, context: context) == result)
        #expect(await previewer.calls.count == 1)

        let wrongExtension = sandbox.appendingPathComponent("proposal.json")
        try Data("{}".utf8).write(to: wrongExtension)
        await #expect(throws: ProposalHandoffError.invalidProposalFile) {
            try await coordinator.open(wrongExtension, context: context)
        }

        let oversized = sandbox.appendingPathComponent("oversized.filmosproposal")
        try Data(repeating: 0, count: 1_024 * 1_024 + 1).write(to: oversized)
        await #expect(throws: ProposalHandoffError.proposalFileTooLarge) {
            try await coordinator.open(oversized, context: context)
        }
        #expect(await previewer.calls.count == 1)
    }

    @Test
    func environmentRuntimeIsFailClosedByDefault() {
        #expect(throws: ProposalHandoffError.disabled) {
            _ = try ProposalOpenRuntime.fromEnvironment([:])
        }
        #expect(throws: ProposalHandoffError.incompleteRuntimeConfiguration) {
            _ = try ProposalOpenRuntime.fromEnvironment([
                "FILMOS_CHATGPT_PROPOSAL_HANDOFF_ENABLED": "true",
            ])
        }
    }

    @Test
    func foundationExecutorAllowsOnlyCanonicalNonSymlinkProcessPaths() async throws {
        let sandbox = try makeSandbox()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let working = sandbox.appendingPathComponent("working", isDirectory: true)
        let output = sandbox.appendingPathComponent("output", isDirectory: true)
        try FileManager.default.createDirectory(at: working, withIntermediateDirectories: true)
        let executor = FoundationProcessExecutor()
        let safeInvocation = ProcessInvocation(
            executableURL: URL(fileURLWithPath: "/usr/bin/true"),
            arguments: [],
            workingDirectoryURL: working,
            environment: ["LANG": "C"],
            outputDirectoryURL: output
        )
        #expect(try await executor.run(safeInvocation).terminationStatus == 0)

        let linkedExecutable = sandbox.appendingPathComponent("python")
        try FileManager.default.createSymbolicLink(
            at: linkedExecutable,
            withDestinationURL: URL(fileURLWithPath: "/usr/bin/true")
        )
        await #expect(throws: ProposalHandoffError.unsafeProcessConfiguration) {
            try await executor.run(ProcessInvocation(
                executableURL: linkedExecutable,
                arguments: [],
                workingDirectoryURL: working,
                environment: [:],
                outputDirectoryURL: output
            ))
        }

        let linkedWorking = sandbox.appendingPathComponent("linked-working", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: linkedWorking, withDestinationURL: working)
        await #expect(throws: ProposalHandoffError.unsafeProcessConfiguration) {
            try await executor.run(ProcessInvocation(
                executableURL: URL(fileURLWithPath: "/usr/bin/true"),
                arguments: [],
                workingDirectoryURL: linkedWorking,
                environment: [:],
                outputDirectoryURL: output
            ))
        }

        let realOutput = sandbox.appendingPathComponent("real-output", isDirectory: true)
        try FileManager.default.createDirectory(at: realOutput, withIntermediateDirectories: true)
        let linkedOutput = sandbox.appendingPathComponent("linked-output", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: linkedOutput, withDestinationURL: realOutput)
        await #expect(throws: ProposalHandoffError.unsafeProcessConfiguration) {
            try await executor.run(ProcessInvocation(
                executableURL: URL(fileURLWithPath: "/usr/bin/true"),
                arguments: [],
                workingDirectoryURL: working,
                environment: [:],
                outputDirectoryURL: linkedOutput
            ))
        }
    }

    private func makeSandbox() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("FilmOSProposalHandoffTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url.resolvingSymlinksInPath()
    }
}
