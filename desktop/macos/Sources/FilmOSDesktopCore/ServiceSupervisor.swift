import Darwin
import Foundation

public struct ServiceID: RawRepresentable, Hashable, Codable, Sendable, ExpressibleByStringLiteral {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public init(stringLiteral value: StringLiteralType) {
        rawValue = value
    }
}

public struct ServiceDefinition: Equatable, Sendable {
    public let id: ServiceID
    public let displayName: String
    public let executableURL: URL
    public let arguments: [String]
    public let workingDirectoryURL: URL
    public let environment: [String: String]

    public init(
        id: ServiceID,
        displayName: String,
        executableURL: URL,
        arguments: [String] = [],
        workingDirectoryURL: URL,
        environment: [String: String] = [:]
    ) {
        self.id = id
        self.displayName = displayName
        self.executableURL = executableURL
        self.arguments = arguments
        self.workingDirectoryURL = workingDirectoryURL
        self.environment = environment
    }
}

public struct ServiceRuntimeEnvironment: Equatable, Sendable {
    public static let empty = try! ServiceRuntimeEnvironment(values: [:], secretKeys: [])

    let values: [String: String]
    let secretKeys: Set<String>

    public init(values: [String: String], secretKeys: Set<String> = []) throws {
        let supportedSecretKeys: Set<String> = [
            "CONTROL_PLANE_API_KEY",
            "FILMOS_SECURE_TUNNEL_PROOF",
        ]
        guard secretKeys.isSubset(of: Set(values.keys)), secretKeys.isSubset(of: supportedSecretKeys) else {
            throw ServiceSupervisorError.invalidEnvironment
        }
        for (key, value) in values {
            guard
                key.range(of: "^[A-Z_][A-Z0-9_]*$", options: .regularExpression) != nil,
                !value.contains("\0"),
                !value.contains("\n"),
                !value.contains("\r"),
                !value.isEmpty,
                !ServiceLaunchPolicy.looksSensitive(key) || secretKeys.contains(key)
            else {
                throw ServiceSupervisorError.invalidEnvironment
            }
        }
        self.values = values
        self.secretKeys = secretKeys
    }

    public var redactedDescription: [String: String] {
        Dictionary(uniqueKeysWithValues: values.map { key, value in
            (key, secretKeys.contains(key) ? "[REDACTED]" : value)
        })
    }
}

public struct ServiceLaunchPolicy: Equatable, Sendable {
    public let allowedExecutableRoots: [URL]
    public let allowedWorkingDirectoryRoots: [URL]

    public init(allowedExecutableRoots: [URL], allowedWorkingDirectoryRoots: [URL]) throws {
        let executableRoots = allowedExecutableRoots.map(Self.canonicalFileURL)
        let workingDirectoryRoots = allowedWorkingDirectoryRoots.map(Self.canonicalFileURL)
        guard
            !executableRoots.isEmpty,
            !workingDirectoryRoots.isEmpty,
            (executableRoots + workingDirectoryRoots).allSatisfy(Self.isAbsoluteNonRootFileURL)
        else {
            throw ServiceSupervisorError.invalidPolicy
        }
        self.allowedExecutableRoots = executableRoots
        self.allowedWorkingDirectoryRoots = workingDirectoryRoots
    }

    fileprivate func validated(_ definition: ServiceDefinition) throws -> ServiceDefinition {
        guard definition.id.rawValue.range(of: "^[a-z][a-z0-9.-]{0,63}$", options: .regularExpression) != nil else {
            throw ServiceSupervisorError.invalidServiceID
        }
        let displayName = definition.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard displayName == definition.displayName, (1...80).contains(displayName.count) else {
            throw ServiceSupervisorError.invalidDisplayName
        }
        guard Self.isAbsoluteNonRootFileURL(definition.executableURL), contains(definition.executableURL, in: allowedExecutableRoots) else {
            throw ServiceSupervisorError.executableOutsidePolicy
        }
        guard Self.isAbsoluteNonRootFileURL(definition.workingDirectoryURL), contains(definition.workingDirectoryURL, in: allowedWorkingDirectoryRoots) else {
            throw ServiceSupervisorError.workingDirectoryOutsidePolicy
        }
        guard definition.arguments.allSatisfy({ !$0.contains("\0") && !$0.contains("\n") && !$0.contains("\r") }) else {
            throw ServiceSupervisorError.invalidArgument
        }
        for (key, value) in definition.environment {
            guard key.range(of: "^[A-Z_][A-Z0-9_]*$", options: .regularExpression) != nil,
                  !value.contains("\0"),
                  !Self.looksSensitive(key) else {
                throw ServiceSupervisorError.invalidEnvironment
            }
        }
        return ServiceDefinition(
            id: definition.id,
            displayName: definition.displayName,
            executableURL: Self.canonicalFileURL(definition.executableURL),
            arguments: definition.arguments,
            workingDirectoryURL: Self.canonicalFileURL(definition.workingDirectoryURL),
            environment: definition.environment
        )
    }

    private static func isAbsoluteNonRootFileURL(_ url: URL) -> Bool {
        let canonical = canonicalFileURL(url)
        return canonical.isFileURL && canonical.path.hasPrefix("/") && canonical.path != "/"
    }

    private func contains(_ candidate: URL, in roots: [URL]) -> Bool {
        let path = Self.canonicalFileURL(candidate).path
        return roots.contains { root in
            let rootPath = Self.canonicalFileURL(root).path
            return path == rootPath || path.hasPrefix(rootPath.hasSuffix("/") ? rootPath : rootPath + "/")
        }
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

    fileprivate static func looksSensitive(_ key: String) -> Bool {
        let fragments = ["TOKEN", "SECRET", "PASSWORD", "COOKIE", "API_KEY", "AUTHORIZATION"]
        return fragments.contains(where: key.contains)
    }
}

public enum ServiceState: Equatable, Sendable {
    case notConfigured
    case stopped
    case starting
    case running(processID: Int32)
    case stopping(processID: Int32)
    case failed(message: String)
}

@MainActor
public protocol ManagedServiceProcess: AnyObject {
    var processIdentifier: Int32 { get }
    var isRunning: Bool { get }
    func requestTermination()
    func forceTermination()
}

@MainActor
public protocol ServiceProcessLaunching {
    func launch(
        _ definition: ServiceDefinition,
        runtimeEnvironment: ServiceRuntimeEnvironment
    ) throws -> any ManagedServiceProcess
}

@MainActor
public final class FoundationServiceProcessLauncher: ServiceProcessLaunching {
    public init() {}

    public func launch(
        _ definition: ServiceDefinition,
        runtimeEnvironment: ServiceRuntimeEnvironment
    ) throws -> any ManagedServiceProcess {
        let process = Process()
        process.executableURL = definition.executableURL
        process.arguments = definition.arguments
        process.currentDirectoryURL = definition.workingDirectoryURL
        process.environment = definition.environment.merging(runtimeEnvironment.values) { _, runtime in runtime }
        try process.run()
        return FoundationManagedServiceProcess(process)
    }
}

@MainActor
private final class FoundationManagedServiceProcess: ManagedServiceProcess {
    private let process: Process

    init(_ process: Process) {
        self.process = process
    }

    var processIdentifier: Int32 { process.processIdentifier }
    var isRunning: Bool { process.isRunning }
    func requestTermination() {
        guard process.isRunning else { return }
        process.terminate()
    }

    func forceTermination() {
        guard process.isRunning else { return }
        _ = Darwin.kill(process.processIdentifier, SIGKILL)
        process.waitUntilExit()
    }
}

public enum ServiceSupervisorError: Error, Equatable, LocalizedError {
    case invalidPolicy
    case invalidServiceID
    case invalidDisplayName
    case executableOutsidePolicy
    case workingDirectoryOutsidePolicy
    case invalidArgument
    case invalidEnvironment
    case duplicateService
    case unknownService
    case invalidState
    case launchFailed

    public var errorDescription: String? {
        switch self {
        case .invalidPolicy: "Service launch policy is invalid."
        case .invalidServiceID: "Service ID is invalid."
        case .invalidDisplayName: "Service display name is invalid."
        case .executableOutsidePolicy: "Service executable is outside the allowed roots."
        case .workingDirectoryOutsidePolicy: "Service working directory is outside the allowed roots."
        case .invalidArgument: "Service argument is invalid."
        case .invalidEnvironment: "Service environment contains invalid or sensitive values."
        case .duplicateService: "Service is already registered."
        case .unknownService: "Service is not registered."
        case .invalidState: "Service cannot perform the requested transition."
        case .launchFailed: "Service failed to launch."
        }
    }
}

@MainActor
public final class ServiceSupervisor {
    private let policy: ServiceLaunchPolicy
    private let launcher: any ServiceProcessLaunching
    private var definitions: [ServiceID: ServiceDefinition] = [:]
    private var states: [ServiceID: ServiceState] = [:]
    private var processes: [ServiceID: any ManagedServiceProcess] = [:]

    public init(policy: ServiceLaunchPolicy, launcher: any ServiceProcessLaunching = FoundationServiceProcessLauncher()) {
        self.policy = policy
        self.launcher = launcher
    }

    public func register(_ definition: ServiceDefinition) throws {
        let definition = try policy.validated(definition)
        guard definitions[definition.id] == nil else {
            throw ServiceSupervisorError.duplicateService
        }
        definitions[definition.id] = definition
        states[definition.id] = .stopped
    }

    public func state(for id: ServiceID) -> ServiceState {
        refreshState(for: id)
        return states[id] ?? .notConfigured
    }

    public func registeredServices() -> [ServiceDefinition] {
        definitions.values.sorted { $0.id.rawValue < $1.id.rawValue }
    }

    public func start(
        _ id: ServiceID,
        runtimeEnvironment: ServiceRuntimeEnvironment = .empty
    ) throws {
        guard let definition = definitions[id] else {
            throw ServiceSupervisorError.unknownService
        }
        refreshState(for: id)
        guard states[id] == .stopped || isFailed(states[id]) else {
            throw ServiceSupervisorError.invalidState
        }
        let validatedDefinition = try policy.validated(definition)

        states[id] = .starting
        do {
            let process = try launcher.launch(
                validatedDefinition,
                runtimeEnvironment: runtimeEnvironment
            )
            processes[id] = process
            states[id] = .running(processID: process.processIdentifier)
        } catch {
            processes[id] = nil
            states[id] = .failed(message: ServiceSupervisorError.launchFailed.localizedDescription)
            throw ServiceSupervisorError.launchFailed
        }
    }

    public func stop(_ id: ServiceID) throws {
        guard definitions[id] != nil else {
            throw ServiceSupervisorError.unknownService
        }
        refreshState(for: id)
        guard processes[id] != nil, case .running = states[id] else {
            throw ServiceSupervisorError.invalidState
        }
        try stopAll([id])
    }

    /// Stops all requested services within one shared grace window. Sending
    /// SIGTERM to every child before waiting prevents shutdown time from growing
    /// linearly with the number of desktop-owned helpers.
    public func stopAll(_ ids: [ServiceID], gracePeriod: TimeInterval = 2) throws {
        let uniqueIDs = ids.reduce(into: [ServiceID]()) { result, id in
            if !result.contains(id) { result.append(id) }
        }
        guard !uniqueIDs.isEmpty else { return }

        var activeProcesses: [(id: ServiceID, process: any ManagedServiceProcess, processID: Int32)] = []
        for id in uniqueIDs {
            guard definitions[id] != nil else {
                throw ServiceSupervisorError.unknownService
            }
            refreshState(for: id)
            guard let process = processes[id], case let .running(processID) = states[id] else { continue }
            activeProcesses.append((id, process, processID))
        }
        guard !activeProcesses.isEmpty else { return }

        for item in activeProcesses {
            states[item.id] = .stopping(processID: item.processID)
            item.process.requestTermination()
        }

        let boundedGracePeriod = min(max(gracePeriod, 0), 5)
        let deadline = Date().addingTimeInterval(boundedGracePeriod)
        while activeProcesses.contains(where: { $0.process.isRunning }), Date() < deadline {
            Thread.sleep(forTimeInterval: min(0.02, max(0, deadline.timeIntervalSinceNow)))
        }

        for item in activeProcesses where item.process.isRunning {
            item.process.forceTermination()
        }
        for item in activeProcesses {
            processes[item.id] = nil
            states[item.id] = .stopped
        }
    }

    private func refreshState(for id: ServiceID) {
        guard let process = processes[id], !process.isRunning else { return }
        processes[id] = nil
        states[id] = .stopped
    }

    private func isFailed(_ state: ServiceState?) -> Bool {
        if case .failed = state { return true }
        return false
    }
}
