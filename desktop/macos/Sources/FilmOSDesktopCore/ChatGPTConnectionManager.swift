import Foundation

public enum ChatGPTConnectionState: String, Codable, Sendable, CaseIterable {
    case notConfigured = "NOT_CONFIGURED"
    case localServicesStarting = "LOCAL_SERVICES_STARTING"
    case localServicesReady = "LOCAL_SERVICES_READY"
    case tunnelStarting = "TUNNEL_STARTING"
    case tunnelConnected = "TUNNEL_CONNECTED"
    case tunnelReconnecting = "TUNNEL_RECONNECTING"
    case tunnelFailed = "TUNNEL_FAILED"
    case waitingForChatGPT = "WAITING_FOR_CHATGPT"
    case chatGPTReachedFilmOS = "CHATGPT_REACHED_FILMOS"
    case grantExpired = "GRANT_EXPIRED"
}

public enum ConnectionCheckStatus: String, Codable, Sendable {
    case notConfigured = "NOT_CONFIGURED"
    case starting = "STARTING"
    case pass = "PASS"
    case connected = "CONNECTED"
    case waiting = "WAITING_FOR_CONNECTION"
    case expired = "EXPIRED"
    case failed = "FAILED"
    case zero = "ZERO"
}

public struct ChatGPTExternalRequest: Equatable, Codable, Sendable {
    public let timestamp: Date
    public let toolName: String
    public let requestID: String
    public let projectScope: String
    public let challengeID: String?
    public let resultHash: String?

    public init(
        timestamp: Date,
        toolName: String,
        requestID: String,
        projectScope: String,
        challengeID: String? = nil,
        resultHash: String? = nil
    ) {
        self.timestamp = timestamp
        self.toolName = toolName
        self.requestID = requestID
        self.projectScope = projectScope
        self.challengeID = challengeID
        self.resultHash = resultHash
    }
}

public struct ChatGPTRuntimeHealth: Equatable, Sendable {
    public let filmCoreReady: Bool
    public let mcpReady: Bool
    public let tunnelReady: Bool
    public let grantExpiresAt: Date?
    public let mcpToolCount: Int
    public let mcpWriteToolCount: Int
    public let externalRequest: ChatGPTExternalRequest?

    public init(
        filmCoreReady: Bool,
        mcpReady: Bool,
        tunnelReady: Bool,
        grantExpiresAt: Date?,
        mcpToolCount: Int = 20,
        mcpWriteToolCount: Int = 0,
        externalRequest: ChatGPTExternalRequest? = nil
    ) {
        self.filmCoreReady = filmCoreReady
        self.mcpReady = mcpReady
        self.tunnelReady = tunnelReady
        self.grantExpiresAt = grantExpiresAt
        self.mcpToolCount = mcpToolCount
        self.mcpWriteToolCount = mcpWriteToolCount
        self.externalRequest = externalRequest
    }
}

public struct ChatGPTConnectionSnapshot: Equatable, Sendable {
    public var state: ChatGPTConnectionState
    public var filmCoreStatus: ConnectionCheckStatus
    public var mcpStatus: ConnectionCheckStatus
    public var tunnelStatus: ConnectionCheckStatus
    public var chatgptReachabilityStatus: ConnectionCheckStatus
    public var grantStatus: ConnectionCheckStatus
    public var billingStatus: ConnectionCheckStatus
    public var mcpToolCount: Int
    public var mcpWriteToolCount: Int
    public var lastError: String?
    public var lastConnectedAt: Date?
    public var lastExternalRequest: ChatGPTExternalRequest?
    public var liveGateChallengeID: String?

    public static let notConfigured = ChatGPTConnectionSnapshot(
        state: .notConfigured,
        filmCoreStatus: .notConfigured,
        mcpStatus: .notConfigured,
        tunnelStatus: .notConfigured,
        chatgptReachabilityStatus: .notConfigured,
        grantStatus: .notConfigured,
        billingStatus: .zero,
        mcpToolCount: 0,
        mcpWriteToolCount: 0,
        lastError: nil,
        lastConnectedAt: nil,
        lastExternalRequest: nil,
        liveGateChallengeID: nil
    )
}

public struct StoredChatGPTConnection: Equatable, Codable, Sendable {
    public let tunnelID: String
    public let projectID: String
    public let autoConnect: Bool

    public init(tunnelID: String, projectID: String, autoConnect: Bool) {
        self.tunnelID = tunnelID
        self.projectID = projectID
        self.autoConnect = autoConnect
    }
}

@MainActor
public protocol ChatGPTConnectionPreferencesStoring: AnyObject {
    func load() -> StoredChatGPTConnection?
    func save(_ value: StoredChatGPTConnection)
    func clear()
}

@MainActor
public final class UserDefaultsChatGPTConnectionPreferences: ChatGPTConnectionPreferencesStoring {
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "filmos.chatgpt.connection.v1") {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> StoredChatGPTConnection? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(StoredChatGPTConnection.self, from: data)
    }

    public func save(_ value: StoredChatGPTConnection) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        defaults.set(data, forKey: key)
    }

    public func clear() {
        defaults.removeObject(forKey: key)
    }
}

public enum ChatGPTConnectionError: Error, Equatable, LocalizedError {
    case invalidTunnelID
    case invalidRuntimeKey
    case projectRequired
    case runtimeCredentialMissing
    case localServicesUnavailable
    case tunnelDoctorFailed
    case tunnelUnavailable
    case grantExpired
    case liveGateNotReady
    case writeToolsExposed

    public var errorDescription: String? {
        switch self {
        case .invalidTunnelID: "Tunnel ID 格式无效。"
        case .invalidRuntimeKey: "Runtime Key 格式无效。"
        case .projectRequired: "需要一个当前 FilmOS 项目。"
        case .runtimeCredentialMissing: "Keychain 中没有 Tunnel Runtime Key。"
        case .localServicesUnavailable: "Film Core 或 FilmOS MCP 未就绪。"
        case .tunnelDoctorFailed: "Secure Tunnel 诊断未通过。"
        case .tunnelUnavailable: "Secure Tunnel 连接失败。"
        case .grantExpired: "Project Grant 已过期。"
        case .liveGateNotReady: "本机连接尚未达到 Live Gate 准备状态。"
        case .writeToolsExposed: "MCP 暴露了写工具，连接已阻断。"
        }
    }
}

@MainActor
public protocol ChatGPTConnectionOperating: AnyObject {
    func prepareLocalServices(projectID: String, transportProof: String) async throws
    func runTunnelDoctor(tunnelID: String, runtimeKey: String, transportProof: String, challengeID: String) async throws
    func startTunnel(tunnelID: String, runtimeKey: String, transportProof: String, challengeID: String) throws
    func stopTunnel()
    func runtimeHealth() async -> ChatGPTRuntimeHealth
}

public struct ReconnectBackoff: Equatable, Sendable {
    public static let desktopDefault = ReconnectBackoff(delays: [1, 2, 5, 10, 30])
    public let delays: [TimeInterval]

    public init(delays: [TimeInterval]) {
        self.delays = delays
    }

    public func delay(forAttempt attempt: Int) -> TimeInterval? {
        guard attempt >= 0, attempt < delays.count else { return nil }
        return delays[attempt]
    }
}

@MainActor
public final class ChatGPTConnectionManager {
    public private(set) var snapshot: ChatGPTConnectionSnapshot = .notConfigured {
        didSet { onSnapshot?(snapshot) }
    }
    public var onSnapshot: ((ChatGPTConnectionSnapshot) -> Void)?

    private let operations: any ChatGPTConnectionOperating
    private let tokenStore: any SecureTokenStoring
    private let preferences: any ChatGPTConnectionPreferencesStoring
    private let backoff: ReconnectBackoff
    private let monitorInterval: TimeInterval
    private var monitorTask: Task<Void, Never>?
    private var desiredConnection = false
    private var currentRuntimeKey: String?
    private var currentTransportProof: String?
    private var currentChallengeID: String?
    private var currentConfiguration: StoredChatGPTConnection?

    public init(
        operations: any ChatGPTConnectionOperating,
        tokenStore: any SecureTokenStoring = KeychainTokenStore(),
        preferences: any ChatGPTConnectionPreferencesStoring = UserDefaultsChatGPTConnectionPreferences(),
        backoff: ReconnectBackoff = .desktopDefault,
        monitorInterval: TimeInterval = 2
    ) {
        self.operations = operations
        self.tokenStore = tokenStore
        self.preferences = preferences
        self.backoff = backoff
        self.monitorInterval = monitorInterval
    }

    public var savedConfiguration: StoredChatGPTConnection? { preferences.load() }

    public func connect(tunnelID: String, runtimeKey: String, projectID: String) async throws {
        let configuration = try Self.validatedConfiguration(tunnelID: tunnelID, projectID: projectID)
        let key = try Self.validatedRuntimeKey(runtimeKey)
        try tokenStore.store(key, for: .openAIMCPTunnelRuntimeKey)
        preferences.save(configuration)
        currentRuntimeKey = key
        try await establish(configuration: configuration, resetChallenge: currentChallengeID == nil)
    }

    public func autoConnectIfConfigured() async {
        guard let configuration = preferences.load(), configuration.autoConnect else { return }
        do {
            let key = try tokenStore.loadString(for: .openAIMCPTunnelRuntimeKey)
            currentRuntimeKey = try Self.validatedRuntimeKey(key)
            try await establish(configuration: configuration, resetChallenge: true)
        } catch {
            fail(error)
        }
    }

    public func reconnect() async throws {
        guard let configuration = currentConfiguration ?? preferences.load() else {
            throw ChatGPTConnectionError.invalidTunnelID
        }
        let key = try currentRuntimeKey ?? tokenStore.loadString(for: .openAIMCPTunnelRuntimeKey)
        currentRuntimeKey = try Self.validatedRuntimeKey(key)
        operations.stopTunnel()
        try await establish(configuration: configuration, resetChallenge: false)
    }

    public func disconnect(clearCredential: Bool = false) {
        desiredConnection = false
        monitorTask?.cancel()
        monitorTask = nil
        operations.stopTunnel()
        currentRuntimeKey = nil
        currentTransportProof = nil
        currentChallengeID = nil
        currentConfiguration = nil
        if clearCredential {
            try? tokenStore.delete(for: .openAIMCPTunnelRuntimeKey)
            preferences.clear()
        }
        snapshot = .notConfigured
    }

    public func refresh() async {
        guard desiredConnection else { return }
        apply(await operations.runtimeHealth())
    }

    public func prepareLiveGate() async throws -> String {
        guard let configuration = currentConfiguration, let runtimeKey = currentRuntimeKey else {
            throw ChatGPTConnectionError.liveGateNotReady
        }
        let health = await operations.runtimeHealth()
        guard health.filmCoreReady, health.mcpReady, health.tunnelReady,
              health.mcpWriteToolCount == 0, grantIsValid(health.grantExpiresAt) else {
            throw ChatGPTConnectionError.liveGateNotReady
        }
        let challengeID = "live_\(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: ""))"
        currentChallengeID = challengeID
        operations.stopTunnel()
        try operations.startTunnel(
            tunnelID: configuration.tunnelID,
            runtimeKey: runtimeKey,
            transportProof: currentTransportProof ?? Self.newTransportProof(),
            challengeID: challengeID
        )
        try await waitForTunnel()
        snapshot.liveGateChallengeID = challengeID
        let prompt = """
        开始 FilmOS ChatGPT Live Gate。
        Challenge ID: \(challengeID)
        仅通过已连接的 FilmOS Studio MCP 读取项目 \(configuration.projectID)。
        读取 Project、ContentUnit、Scene、DirectorUnit、Shot、SceneTwin、Asset、GenerationAttempt 以及 QC/Approval 状态；不得根据本提示猜测，不得调用写工具。
        回答时带上 Challenge ID，并说明读取到的对象 ID 与状态。
        """
        return prompt
    }

    public func diagnosticReport() async -> String {
        let health = await operations.runtimeHealth()
        let tunnelIDPresent = preferences.load()?.tunnelID.isEmpty == false
        let runtimeCredentialPresent = (try? tokenStore.load(for: .openAIMCPTunnelRuntimeKey)) != nil
        return """
        FilmOS ChatGPT Connection Doctor

        Desktop              PASS
        Film Core            \(health.filmCoreReady ? "PASS" : "FAIL")
        MCP                  \(health.mcpReady ? "PASS" : "FAIL")
        MCP Tools            \(health.mcpToolCount)
        Write Tools          \(health.mcpWriteToolCount)
        Tunnel Client        PASS
        Tunnel ID            \(tunnelIDPresent ? "PASS" : "FAIL")
        Runtime Credential   \(runtimeCredentialPresent ? "PASS" : "FAIL")
        Runtime Key          [REDACTED]
        Secure Tunnel        \(health.tunnelReady ? "PASS" : "FAIL")
        Project Grant        \(grantIsValid(health.grantExpiresAt) ? "PASS" : "FAIL")
        Model API Billing    ZERO

        Overall:
        \(health.filmCoreReady && health.mcpReady && health.tunnelReady && health.mcpWriteToolCount == 0 && grantIsValid(health.grantExpiresAt) ? "READY_FOR_CHATGPT" : "NOT_READY")
        """
    }

    private func establish(configuration: StoredChatGPTConnection, resetChallenge: Bool) async throws {
        monitorTask?.cancel()
        desiredConnection = true
        currentConfiguration = configuration
        let runtimeKey = try currentRuntimeKey ?? tokenStore.loadString(for: .openAIMCPTunnelRuntimeKey)
        let transportProof = Self.newTransportProof()
        currentRuntimeKey = runtimeKey
        currentTransportProof = transportProof
        if resetChallenge || currentChallengeID == nil {
            currentChallengeID = "live_\(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: ""))"
        }

        snapshot = ChatGPTConnectionSnapshot.notConfigured
        snapshot.state = .localServicesStarting
        snapshot.filmCoreStatus = .starting
        snapshot.mcpStatus = .starting
        do {
            try await operations.prepareLocalServices(projectID: configuration.projectID, transportProof: transportProof)
            var health = await operations.runtimeHealth()
            guard health.filmCoreReady, health.mcpReady else { throw ChatGPTConnectionError.localServicesUnavailable }
            guard health.mcpWriteToolCount == 0 else { throw ChatGPTConnectionError.writeToolsExposed }
            guard grantIsValid(health.grantExpiresAt) else { throw ChatGPTConnectionError.grantExpired }
            snapshot.state = .localServicesReady
            apply(health)
            snapshot.state = .tunnelStarting
            snapshot.tunnelStatus = .starting
            try await operations.runTunnelDoctor(
                tunnelID: configuration.tunnelID,
                runtimeKey: runtimeKey,
                transportProof: transportProof,
                challengeID: currentChallengeID!
            )
            try operations.startTunnel(
                tunnelID: configuration.tunnelID,
                runtimeKey: runtimeKey,
                transportProof: transportProof,
                challengeID: currentChallengeID!
            )
            try await waitForTunnel()
            health = await operations.runtimeHealth()
            apply(health)
            beginMonitoring()
        } catch {
            fail(error)
            throw error
        }
    }

    private func waitForTunnel() async throws {
        for _ in 0..<60 {
            try Task.checkCancellation()
            let health = await operations.runtimeHealth()
            if health.tunnelReady { return }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw ChatGPTConnectionError.tunnelUnavailable
    }

    private func beginMonitoring() {
        monitorTask?.cancel()
        monitorTask = Task { [weak self] in
            guard let self else { return }
            var attempt = 0
            while !Task.isCancelled, self.desiredConnection {
                let health = await self.operations.runtimeHealth()
                if health.tunnelReady {
                    if let expiresAt = health.grantExpiresAt,
                       expiresAt.timeIntervalSinceNow <= 300,
                       let configuration = self.currentConfiguration,
                       let runtimeKey = self.currentRuntimeKey,
                       let transportProof = self.currentTransportProof,
                       let challengeID = self.currentChallengeID {
                        do {
                            try await self.operations.prepareLocalServices(
                                projectID: configuration.projectID,
                                transportProof: transportProof
                            )
                            self.operations.stopTunnel()
                            try self.operations.startTunnel(
                                tunnelID: configuration.tunnelID,
                                runtimeKey: runtimeKey,
                                transportProof: transportProof,
                                challengeID: challengeID
                            )
                            attempt = 0
                            continue
                        } catch {
                            self.fail(error)
                            return
                        }
                    }
                    attempt = 0
                    self.apply(health)
                    try? await Task.sleep(for: .seconds(self.monitorInterval))
                    continue
                }
                guard let delay = self.backoff.delay(forAttempt: attempt),
                      let configuration = self.currentConfiguration,
                      let runtimeKey = self.currentRuntimeKey,
                      let transportProof = self.currentTransportProof,
                      let challengeID = self.currentChallengeID else {
                    self.fail(ChatGPTConnectionError.tunnelUnavailable)
                    return
                }
                self.snapshot.state = .tunnelReconnecting
                self.snapshot.tunnelStatus = .starting
                try? await Task.sleep(for: .seconds(delay))
                if Task.isCancelled { return }
                self.operations.stopTunnel()
                do {
                    try self.operations.startTunnel(
                        tunnelID: configuration.tunnelID,
                        runtimeKey: runtimeKey,
                        transportProof: transportProof,
                        challengeID: challengeID
                    )
                } catch {
                    attempt += 1
                    continue
                }
                attempt += 1
            }
        }
    }

    private func apply(_ health: ChatGPTRuntimeHealth) {
        snapshot.filmCoreStatus = health.filmCoreReady ? .pass : .failed
        snapshot.mcpStatus = health.mcpReady ? .pass : .failed
        snapshot.tunnelStatus = health.tunnelReady ? .connected : .failed
        snapshot.mcpToolCount = health.mcpToolCount
        snapshot.mcpWriteToolCount = health.mcpWriteToolCount
        snapshot.grantStatus = grantIsValid(health.grantExpiresAt) ? .pass : .expired
        snapshot.billingStatus = .zero
        snapshot.lastExternalRequest = health.externalRequest
        if let request = health.externalRequest {
            snapshot.state = .chatGPTReachedFilmOS
            snapshot.chatgptReachabilityStatus = .connected
            snapshot.lastConnectedAt = request.timestamp
        } else if health.tunnelReady {
            snapshot.state = .waitingForChatGPT
            snapshot.chatgptReachabilityStatus = .waiting
            snapshot.lastConnectedAt = Date()
        }
        snapshot.lastError = nil
    }

    private func grantIsValid(_ expiresAt: Date?) -> Bool {
        guard let expiresAt else { return false }
        return expiresAt.timeIntervalSinceNow > 60
    }

    private func fail(_ error: Error) {
        snapshot.state = error as? ChatGPTConnectionError == .grantExpired ? .grantExpired : .tunnelFailed
        snapshot.lastError = Self.safeError(error)
        if snapshot.state == .grantExpired { snapshot.grantStatus = .expired }
        else { snapshot.tunnelStatus = .failed }
    }

    private static func validatedConfiguration(tunnelID: String, projectID: String) throws -> StoredChatGPTConnection {
        let tunnelID = tunnelID.trimmingCharacters(in: .whitespacesAndNewlines)
        let projectID = projectID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard tunnelID.range(of: "^tunnel_[A-Za-z0-9_-]{8,128}$", options: .regularExpression) != nil else {
            throw ChatGPTConnectionError.invalidTunnelID
        }
        guard projectID.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", options: .regularExpression) != nil else {
            throw ChatGPTConnectionError.projectRequired
        }
        return StoredChatGPTConnection(tunnelID: tunnelID, projectID: projectID, autoConnect: true)
    }

    private static func validatedRuntimeKey(_ value: String) throws -> String {
        let key = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, key.utf8.count <= 16_384, !key.contains("\0"), !key.contains("\n"), !key.contains("\r") else {
            throw ChatGPTConnectionError.invalidRuntimeKey
        }
        return key
    }

    private static func newTransportProof() -> String {
        UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
    }

    private static func safeError(_ error: Error) -> String {
        if let connectionError = error as? ChatGPTConnectionError {
            return connectionError.localizedDescription
        }
        if error as? SecureTokenStoreError == .tokenNotFound {
            return ChatGPTConnectionError.runtimeCredentialMissing.localizedDescription
        }
        return "ChatGPT 连接未完成；请运行本地诊断。"
    }
}
