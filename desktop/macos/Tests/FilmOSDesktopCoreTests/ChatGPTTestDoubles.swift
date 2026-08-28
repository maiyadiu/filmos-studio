import Foundation

@testable import FilmOSDesktopCore

final class MemorySecureTokenStore: SecureTokenStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [SecureTokenKey: Data] = [:]

    func store(_ token: Data, for key: SecureTokenKey) throws {
        guard !token.isEmpty else { throw SecureTokenStoreError.emptyToken }
        lock.lock()
        values[key] = token
        lock.unlock()
    }

    func load(for key: SecureTokenKey) throws -> Data {
        lock.lock()
        let token = values[key]
        lock.unlock()
        guard let token else { throw SecureTokenStoreError.tokenNotFound }
        return token
    }

    func delete(for key: SecureTokenKey) throws {
        lock.lock()
        values[key] = nil
        lock.unlock()
    }
}

actor CapturingProcessExecutor: ProcessExecuting {
    private(set) var invocation: ProcessInvocation?
    private let result: ProcessExecutionResult
    private let writeReceipt: Bool

    init(result: ProcessExecutionResult, writeReceipt: Bool = true) {
        self.result = result
        self.writeReceipt = writeReceipt
    }

    func run(_ invocation: ProcessInvocation) async throws -> ProcessExecutionResult {
        self.invocation = invocation
        if writeReceipt,
           let receiptFlag = invocation.arguments.firstIndex(of: "--receipt-file"),
           invocation.arguments.indices.contains(receiptFlag + 1) {
            let receiptURL = URL(fileURLWithPath: invocation.arguments[receiptFlag + 1])
            try FileManager.default.createDirectory(
                at: receiptURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try Data("{\"kind\":\"FILMOS_PROPOSAL_IMPORT_PREVIEW_RECEIPT\"}".utf8).write(to: receiptURL)
        }
        return result
    }
}

actor CapturingProposalPreviewer: FilmCoreProposalPreviewing {
    private(set) var calls: [(URL, FilmCoreProposalPreviewContext)] = []
    private let result: FilmCoreProposalPreview

    init(result: FilmCoreProposalPreview) {
        self.result = result
    }

    func preview(fileURL: URL, context: FilmCoreProposalPreviewContext) async throws -> FilmCoreProposalPreview {
        calls.append((fileURL, context))
        return result
    }
}
