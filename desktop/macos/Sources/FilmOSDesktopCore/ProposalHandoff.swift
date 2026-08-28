import Foundation

public struct FilmCoreProposalPreviewContext: Equatable, Sendable {
    public let projectID: String
    public let stateHash: String
    public let versionsByEntityURI: [String: Int]

    public init(projectID: String, stateHash: String, versionsByEntityURI: [String: Int]) {
        self.projectID = projectID
        self.stateHash = stateHash
        self.versionsByEntityURI = versionsByEntityURI
    }
}

public struct FilmCoreProposalPreview: Equatable, Sendable {
    public let kind: String
    public let status: String
    public let formalWriteExecuted: Bool
    public let receiptURL: URL
    public let displayJSON: Data

    public init(
        kind: String,
        status: String,
        formalWriteExecuted: Bool,
        receiptURL: URL,
        displayJSON: Data
    ) {
        self.kind = kind
        self.status = status
        self.formalWriteExecuted = formalWriteExecuted
        self.receiptURL = receiptURL
        self.displayJSON = displayJSON
    }
}

public enum ProposalHandoffError: Error, Equatable, LocalizedError {
    case disabled
    case incompleteRuntimeConfiguration
    case invalidRuntimeConfiguration
    case invalidProposalFile
    case proposalFileTooLarge
    case unsafeProcessConfiguration
    case processLaunchFailed
    case processOutputTooLarge
    case filmCoreFailed(Int32)
    case importRejected(code: String, message: String)
    case unsafePreviewResponse
    case receiptMissing

    public var errorDescription: String? {
        switch self {
        case .disabled:
            "ChatGPT proposal handoff is disabled."
        case .incompleteRuntimeConfiguration:
            "Open a FilmOS project before previewing the proposal."
        case .invalidRuntimeConfiguration:
            "The Film Core proposal preview runtime is invalid."
        case .invalidProposalFile:
            "The selected file is not a safe .filmosproposal file."
        case .proposalFileTooLarge:
            "The proposal package exceeds the desktop preview size limit."
        case .unsafeProcessConfiguration:
            "The Film Core preview process configuration is unsafe."
        case .processLaunchFailed:
            "Film Core proposal preview could not be started."
        case .processOutputTooLarge:
            "Film Core proposal preview returned too much output."
        case let .filmCoreFailed(status):
            "Film Core proposal preview failed with exit status \(status)."
        case let .importRejected(code, _):
            "Film Core rejected the proposal (\(code))."
        case .unsafePreviewResponse:
            "Film Core did not return a safe preview-only result."
        case .receiptMissing:
            "Film Core did not write the expected preview receipt."
        }
    }
}

struct ProcessInvocation: Equatable, Sendable {
    let executableURL: URL
    let arguments: [String]
    let workingDirectoryURL: URL
    let environment: [String: String]
    let outputDirectoryURL: URL

    init(
        executableURL: URL,
        arguments: [String],
        workingDirectoryURL: URL,
        environment: [String: String],
        outputDirectoryURL: URL
    ) {
        self.executableURL = executableURL
        self.arguments = arguments
        self.workingDirectoryURL = workingDirectoryURL
        self.environment = environment
        self.outputDirectoryURL = outputDirectoryURL
    }
}

struct ProcessExecutionResult: Equatable, Sendable {
    let terminationStatus: Int32
    let standardOutput: Data
    let standardError: Data

    init(terminationStatus: Int32, standardOutput: Data, standardError: Data) {
        self.terminationStatus = terminationStatus
        self.standardOutput = standardOutput
        self.standardError = standardError
    }
}

protocol ProcessExecuting: Sendable {
    func run(_ invocation: ProcessInvocation) async throws -> ProcessExecutionResult
}

final class FoundationProcessExecutor: ProcessExecuting, @unchecked Sendable {
    private let fileManager: FileManager
    private let maximumOutputBytes: Int
    private let timeoutSeconds: TimeInterval

    init(
        fileManager: FileManager = .default,
        maximumOutputBytes: Int = 1_048_576,
        timeoutSeconds: TimeInterval = 20
    ) {
        self.fileManager = fileManager
        self.maximumOutputBytes = maximumOutputBytes
        self.timeoutSeconds = timeoutSeconds
    }

    func run(_ invocation: ProcessInvocation) async throws -> ProcessExecutionResult {
        try validate(invocation)
        try fileManager.createDirectory(
            at: invocation.outputDirectoryURL,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: invocation.outputDirectoryURL.path)

        let identifier = UUID().uuidString.lowercased()
        let stdoutURL = invocation.outputDirectoryURL.appendingPathComponent(".preview-\(identifier).stdout")
        let stderrURL = invocation.outputDirectoryURL.appendingPathComponent(".preview-\(identifier).stderr")
        let stdoutCreated = fileManager.createFile(
            atPath: stdoutURL.path,
            contents: nil,
            attributes: [.posixPermissions: 0o600]
        )
        let stderrCreated = fileManager.createFile(
            atPath: stderrURL.path,
            contents: nil,
            attributes: [.posixPermissions: 0o600]
        )
        guard stdoutCreated, stderrCreated else {
            try? fileManager.removeItem(at: stdoutURL)
            try? fileManager.removeItem(at: stderrURL)
            throw ProposalHandoffError.processLaunchFailed
        }

        do {
            let stdoutHandle = try FileHandle(forWritingTo: stdoutURL)
            let stderrHandle = try FileHandle(forWritingTo: stderrURL)
            let process = Process()
            process.executableURL = invocation.executableURL
            process.arguments = invocation.arguments
            process.currentDirectoryURL = invocation.workingDirectoryURL
            process.environment = invocation.environment
            process.standardOutput = stdoutHandle
            process.standardError = stderrHandle
            let timeoutWorkItem = DispatchWorkItem {
                if process.isRunning { process.terminate() }
            }

            return try await withCheckedThrowingContinuation { continuation in
                process.terminationHandler = { [maximumOutputBytes] finished in
                    let callbackFileManager = FileManager.default
                    try? stdoutHandle.close()
                    try? stderrHandle.close()
                    defer {
                        try? callbackFileManager.removeItem(at: stdoutURL)
                        try? callbackFileManager.removeItem(at: stderrURL)
                    }
                    do {
                        let stdoutSize = try Self.fileSize(at: stdoutURL, fileManager: callbackFileManager)
                        let stderrSize = try Self.fileSize(at: stderrURL, fileManager: callbackFileManager)
                        guard stdoutSize <= maximumOutputBytes, stderrSize <= maximumOutputBytes else {
                            throw ProposalHandoffError.processOutputTooLarge
                        }
                        continuation.resume(returning: ProcessExecutionResult(
                            terminationStatus: finished.terminationStatus,
                            standardOutput: try Data(contentsOf: stdoutURL),
                            standardError: try Data(contentsOf: stderrURL)
                        ))
                    } catch let error as ProposalHandoffError {
                        continuation.resume(throwing: error)
                    } catch {
                        continuation.resume(throwing: ProposalHandoffError.processLaunchFailed)
                    }
                }
                do {
                    try process.run()
                    DispatchQueue.global(qos: .utility).asyncAfter(
                        deadline: .now() + timeoutSeconds,
                        execute: timeoutWorkItem
                    )
                } catch {
                    try? stdoutHandle.close()
                    try? stderrHandle.close()
                    try? fileManager.removeItem(at: stdoutURL)
                    try? fileManager.removeItem(at: stderrURL)
                    continuation.resume(throwing: ProposalHandoffError.processLaunchFailed)
                }
            }
        } catch let error as ProposalHandoffError {
            try? fileManager.removeItem(at: stdoutURL)
            try? fileManager.removeItem(at: stderrURL)
            throw error
        } catch {
            try? fileManager.removeItem(at: stdoutURL)
            try? fileManager.removeItem(at: stderrURL)
            throw ProposalHandoffError.processLaunchFailed
        }
    }

    private func validate(_ invocation: ProcessInvocation) throws {
        let executable = invocation.executableURL.standardizedFileURL
        let workingDirectory = invocation.workingDirectoryURL.standardizedFileURL
        let outputDirectory = invocation.outputDirectoryURL.standardizedFileURL
        guard
            Self.isAbsoluteNonRootFileURL(executable),
            Self.isAbsoluteNonRootFileURL(workingDirectory),
            Self.isAbsoluteNonRootFileURL(outputDirectory),
            Self.canonicalFileURL(executable).path == executable.path,
            Self.canonicalFileURL(workingDirectory).path == workingDirectory.path,
            Self.canonicalFileURL(outputDirectory).path == outputDirectory.path,
            fileManager.isExecutableFile(atPath: executable.path),
            Self.isDirectory(workingDirectory, fileManager: fileManager),
            invocation.arguments.allSatisfy(Self.isSafeProcessValue),
            invocation.environment.keys.allSatisfy({
                $0.range(of: "^[A-Z_][A-Z0-9_]*$", options: .regularExpression) != nil
            }),
            invocation.environment.values.allSatisfy(Self.isSafeProcessValue)
        else {
            throw ProposalHandoffError.unsafeProcessConfiguration
        }
    }

    private static func isAbsoluteNonRootFileURL(_ url: URL) -> Bool {
        url.isFileURL && url.path.hasPrefix("/") && url.path != "/"
    }

    private static func canonicalFileURL(_ url: URL) -> URL {
        let standardized = url.standardizedFileURL
        var existingAncestor = standardized
        var missingComponents: [String] = []
        while existingAncestor.path != "/", !FileManager.default.fileExists(atPath: existingAncestor.path) {
            missingComponents.insert(existingAncestor.lastPathComponent, at: 0)
            existingAncestor.deleteLastPathComponent()
        }
        return missingComponents.reduce(existingAncestor.resolvingSymlinksInPath()) { partialURL, component in
            partialURL.appendingPathComponent(component)
        }.standardizedFileURL
    }

    private static func isSafeProcessValue(_ value: String) -> Bool {
        !value.contains("\0") && !value.contains("\n") && !value.contains("\r")
    }

    private static func isDirectory(_ url: URL, fileManager: FileManager) -> Bool {
        var isDirectory: ObjCBool = false
        return fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    private static func fileSize(at url: URL, fileManager: FileManager) throws -> Int {
        let attributes = try fileManager.attributesOfItem(atPath: url.path)
        return (attributes[.size] as? NSNumber)?.intValue ?? 0
    }
}

public struct FilmCoreCLIPreviewConfiguration: Equatable, Sendable {
    public let pythonExecutableURL: URL
    public let filmCoreAppURL: URL
    public let receiptDirectoryURL: URL

    public init(pythonExecutableURL: URL, filmCoreAppURL: URL, receiptDirectoryURL: URL) {
        self.pythonExecutableURL = pythonExecutableURL
        self.filmCoreAppURL = filmCoreAppURL
        self.receiptDirectoryURL = receiptDirectoryURL
    }
}

public protocol FilmCoreProposalPreviewing: Sendable {
    func preview(fileURL: URL, context: FilmCoreProposalPreviewContext) async throws -> FilmCoreProposalPreview
}

public final class FilmCoreCLIProposalPreviewer: FilmCoreProposalPreviewing, @unchecked Sendable {
    private let configuration: FilmCoreCLIPreviewConfiguration
    private let tokenStore: any SecureTokenStoring
    private let processExecutor: any ProcessExecuting
    private let fileManager: FileManager
    private let makeReceiptID: @Sendable () -> String

    public init(
        configuration: FilmCoreCLIPreviewConfiguration,
        tokenStore: any SecureTokenStoring = KeychainTokenStore(),
        fileManager: FileManager = .default
    ) {
        self.configuration = Self.canonicalConfiguration(configuration)
        self.tokenStore = tokenStore
        processExecutor = FoundationProcessExecutor(fileManager: fileManager)
        self.fileManager = fileManager
        makeReceiptID = { UUID().uuidString.lowercased() }
    }

    init(
        configuration: FilmCoreCLIPreviewConfiguration,
        tokenStore: any SecureTokenStoring,
        processExecutor: any ProcessExecuting,
        fileManager: FileManager = .default,
        makeReceiptID: @escaping @Sendable () -> String
    ) {
        self.configuration = Self.canonicalConfiguration(configuration)
        self.tokenStore = tokenStore
        self.processExecutor = processExecutor
        self.fileManager = fileManager
        self.makeReceiptID = makeReceiptID
    }

    public func preview(fileURL: URL, context: FilmCoreProposalPreviewContext) async throws -> FilmCoreProposalPreview {
        let signingSecret = try tokenStore.loadString(for: .proposalSigningSecret)
        let versionsData = try JSONSerialization.data(withJSONObject: context.versionsByEntityURI, options: [.sortedKeys])
        guard let versionsJSON = String(data: versionsData, encoding: .utf8) else {
            throw ProposalHandoffError.invalidRuntimeConfiguration
        }

        try fileManager.createDirectory(
            at: configuration.receiptDirectoryURL,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try fileManager.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: configuration.receiptDirectoryURL.path
        )
        let receiptID = makeReceiptID()
        guard receiptID.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil else {
            throw ProposalHandoffError.invalidRuntimeConfiguration
        }
        let receiptURL = configuration.receiptDirectoryURL
            .appendingPathComponent("proposal-preview-\(receiptID).json", isDirectory: false)
            .standardizedFileURL
        let stagedProposalURL = try stageProposalInput(fileURL, receiptID: receiptID)
        defer { try? fileManager.removeItem(at: stagedProposalURL) }
        guard !fileManager.fileExists(atPath: receiptURL.path) else {
            throw ProposalHandoffError.invalidRuntimeConfiguration
        }

        let invocation = ProcessInvocation(
            executableURL: configuration.pythonExecutableURL,
            arguments: [
                "-m", "external_brains.chatgpt.cli", "preview", stagedProposalURL.path,
                "--project-id", context.projectID,
                "--state-hash", context.stateHash,
                "--versions-json", versionsJSON,
                "--receipt-file", receiptURL.path,
            ],
            workingDirectoryURL: configuration.filmCoreAppURL,
            environment: [
                "PYTHONPATH": configuration.filmCoreAppURL.path,
                "FILMOS_CHATGPT_PROPOSAL_SIGNING_SECRET": signingSecret,
                "LANG": "en_US.UTF-8",
                "LC_ALL": "en_US.UTF-8",
            ],
            outputDirectoryURL: configuration.receiptDirectoryURL
        )
        let result = try await processExecutor.run(invocation)

        if result.terminationStatus == 2,
           let rejection = try? JSONDecoder().decode(ImportRejection.self, from: result.standardError),
           !rejection.ok,
           rejection.kind == "FILMOS_PROPOSAL_IMPORT_REJECTED" {
            throw ProposalHandoffError.importRejected(code: rejection.code, message: rejection.message)
        }
        guard result.terminationStatus == 0 else {
            throw ProposalHandoffError.filmCoreFailed(result.terminationStatus)
        }

        let envelope: ImportPreviewEnvelope
        do {
            envelope = try JSONDecoder().decode(ImportPreviewEnvelope.self, from: result.standardOutput)
        } catch {
            throw ProposalHandoffError.unsafePreviewResponse
        }
        guard
            envelope.ok,
            envelope.kind == "FILMOS_PROPOSAL_IMPORT_PREVIEW",
            envelope.preview.status == "PREVIEW_REQUIRES_HUMAN_APPROVAL",
            !envelope.preview.formalWriteExecuted
        else {
            throw ProposalHandoffError.unsafePreviewResponse
        }
        let receiptValues = try? receiptURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard
            receiptValues?.isRegularFile == true,
            receiptValues?.isSymbolicLink != true,
            (receiptValues?.fileSize ?? 1_048_577) <= 1_048_576
        else {
            throw ProposalHandoffError.receiptMissing
        }

        return FilmCoreProposalPreview(
            kind: envelope.kind,
            status: envelope.preview.status,
            formalWriteExecuted: envelope.preview.formalWriteExecuted,
            receiptURL: receiptURL,
            displayJSON: Self.redactedDisplayJSON(result.standardOutput)
        )
    }

    private static func canonicalConfiguration(_ configuration: FilmCoreCLIPreviewConfiguration) -> FilmCoreCLIPreviewConfiguration {
        FilmCoreCLIPreviewConfiguration(
            pythonExecutableURL: configuration.pythonExecutableURL.standardizedFileURL.resolvingSymlinksInPath(),
            filmCoreAppURL: configuration.filmCoreAppURL.standardizedFileURL.resolvingSymlinksInPath(),
            receiptDirectoryURL: configuration.receiptDirectoryURL.standardizedFileURL.resolvingSymlinksInPath()
        )
    }

    private func stageProposalInput(_ fileURL: URL, receiptID: String) throws -> URL {
        guard fileURL.pathExtension.lowercased() == "filmosproposal" else {
            throw ProposalHandoffError.invalidProposalFile
        }
        let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw ProposalHandoffError.invalidProposalFile
        }
        guard (values.fileSize ?? 1_024 * 1_024 + 1) <= 1_024 * 1_024 else {
            throw ProposalHandoffError.proposalFileTooLarge
        }
        let data = try Data(contentsOf: fileURL, options: [.uncached])
        guard data.count <= 1_024 * 1_024 else {
            throw ProposalHandoffError.proposalFileTooLarge
        }
        let stagedURL = configuration.receiptDirectoryURL
            .appendingPathComponent("proposal-input-\(receiptID).filmosproposal", isDirectory: false)
            .standardizedFileURL
        do {
            try data.write(to: stagedURL, options: [.withoutOverwriting])
            try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stagedURL.path)
            return stagedURL
        } catch {
            try? fileManager.removeItem(at: stagedURL)
            throw ProposalHandoffError.invalidRuntimeConfiguration
        }
    }

    private static func redactedDisplayJSON(_ data: Data) -> Data {
        guard let object = try? JSONSerialization.jsonObject(with: data) else { return Data() }
        let redacted = redact(object)
        return (try? JSONSerialization.data(withJSONObject: redacted, options: [.sortedKeys])) ?? Data()
    }

    private static func redact(_ value: Any, key: String? = nil) -> Any {
        if let key {
            let lowered = key.lowercased()
            if ["secret", "token", "password", "cookie", "authorization"].contains(where: lowered.contains) {
                return "<redacted>"
            }
        }
        if let dictionary = value as? [String: Any] {
            var result: [String: Any] = [:]
            for (entryKey, entryValue) in dictionary {
                result[entryKey] = redact(entryValue, key: entryKey)
            }
            return result
        }
        if let array = value as? [Any] {
            return array.map { redact($0) }
        }
        if let string = value as? String {
            let lowered = string.lowercased()
            if string.hasPrefix("/") || lowered.hasPrefix("file://") ||
                string.contains("/Users/") || string.contains("/Volumes/") || string.contains("/private/") {
                return "<redacted-local-path>"
            }
        }
        return value
    }
}

public final class ProposalFileOpenCoordinator: @unchecked Sendable {
    private let previewer: any FilmCoreProposalPreviewing
    private let fileManager: FileManager
    private let maximumFileBytes: Int

    public init(
        previewer: any FilmCoreProposalPreviewing,
        fileManager: FileManager = .default,
        maximumFileBytes: Int = 1_024 * 1_024
    ) {
        self.previewer = previewer
        self.fileManager = fileManager
        self.maximumFileBytes = maximumFileBytes
    }

    public func open(_ fileURL: URL, context: FilmCoreProposalPreviewContext) async throws -> FilmCoreProposalPreview {
        let requestedURL = fileURL.standardizedFileURL
        guard
            requestedURL.isFileURL,
            requestedURL.pathExtension.lowercased() == "filmosproposal",
            !requestedURL.path.contains("\0"),
            !requestedURL.path.contains("\n"),
            !requestedURL.path.contains("\r")
        else {
            throw ProposalHandoffError.invalidProposalFile
        }

        let values = try requestedURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw ProposalHandoffError.invalidProposalFile
        }
        guard (values.fileSize ?? maximumFileBytes + 1) <= maximumFileBytes else {
            throw ProposalHandoffError.proposalFileTooLarge
        }
        return try await previewer.preview(fileURL: requestedURL, context: context)
    }
}

public struct ProposalOpenRuntime: Sendable {
    private let coordinator: ProposalFileOpenCoordinator
    public let context: FilmCoreProposalPreviewContext

    public init(coordinator: ProposalFileOpenCoordinator, context: FilmCoreProposalPreviewContext) {
        self.coordinator = coordinator
        self.context = context
    }

    public func open(_ fileURL: URL) async throws -> FilmCoreProposalPreview {
        try await coordinator.open(fileURL, context: context)
    }

    public static func fromEnvironment(
        _ environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default,
        tokenStore: any SecureTokenStoring = KeychainTokenStore()
    ) throws -> ProposalOpenRuntime {
        guard environment["FILMOS_CHATGPT_PROPOSAL_HANDOFF_ENABLED"] == "true" else {
            throw ProposalHandoffError.disabled
        }
        guard
            let pythonPath = environment["FILMOS_CORE_PYTHON"],
            let filmCoreAppPath = environment["FILMOS_CORE_APP_DIR"],
            let projectID = environment["FILMOS_ACTIVE_PROJECT_ID"],
            let stateHash = environment["FILMOS_ACTIVE_STATE_HASH"],
            let versionsJSON = environment["FILMOS_ACTIVE_VERSIONS_JSON"],
            let versionsData = versionsJSON.data(using: .utf8),
            let versions = try? JSONDecoder().decode([String: Int].self, from: versionsData),
            (pythonPath as NSString).isAbsolutePath,
            (filmCoreAppPath as NSString).isAbsolutePath,
            pythonPath != "/",
            filmCoreAppPath != "/"
        else {
            throw ProposalHandoffError.incompleteRuntimeConfiguration
        }

        let dataLayout = try LocalDataLayout.resolve(fileManager: fileManager)
        try dataLayout.prepareDirectories(fileManager: fileManager)
        let receiptDirectory = dataLayout.runtimeStateURL.appendingPathComponent("ProposalReceipts", isDirectory: true)
        let configuration = FilmCoreCLIPreviewConfiguration(
            pythonExecutableURL: URL(fileURLWithPath: pythonPath),
            filmCoreAppURL: URL(fileURLWithPath: filmCoreAppPath, isDirectory: true),
            receiptDirectoryURL: receiptDirectory
        )
        let previewer = FilmCoreCLIProposalPreviewer(
            configuration: configuration,
            tokenStore: tokenStore,
            fileManager: fileManager
        )
        return ProposalOpenRuntime(
            coordinator: ProposalFileOpenCoordinator(previewer: previewer, fileManager: fileManager),
            context: FilmCoreProposalPreviewContext(
                projectID: projectID,
                stateHash: stateHash,
                versionsByEntityURI: versions
            )
        )
    }
}

private struct ImportPreviewEnvelope: Decodable {
    let ok: Bool
    let kind: String
    let preview: ImportPreviewPayload
}

private struct ImportPreviewPayload: Decodable {
    let status: String
    let formalWriteExecuted: Bool

    enum CodingKeys: String, CodingKey {
        case status
        case formalWriteExecuted = "formal_write_executed"
    }
}

private struct ImportRejection: Decodable {
    let ok: Bool
    let kind: String
    let code: String
    let message: String
}
