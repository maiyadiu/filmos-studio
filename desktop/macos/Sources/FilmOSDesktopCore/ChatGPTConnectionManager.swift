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
    public let connectionID: String?
    public let mcpSessionID: String?
    public let expiresAt: Date?

    public init(
        timestamp: Date,
        toolName: String,
        requestID: String,
        projectScope: String,
        challengeID: String? = nil,
        resultHash: String? = nil,
        connectionID: String? = nil,
        mcpSessionID: String? = nil,
        expiresAt: Date? = nil
    ) {
        self.timestamp = timestamp
        self.toolName = toolName
        self.requestID = requestID
        self.projectScope = projectScope
        self.challengeID = challengeID
        self.resultHash = resultHash
        self.connectionID = connectionID
        self.mcpSessionID = mcpSessionID
        self.expiresAt = expiresAt
    }
}

public struct ChatGPTRuntimeHealth: Equatable, Sendable {
    public let filmCoreReady: Bool
    public let mcpReady: Bool
    public let tunnelReady: Bool
    public let grantExpiresAt: Date?
    public let mcpToolCount: Int
    public let mcpReadToolCount: Int
    public let mcpWriteToolCount: Int
    public let mcpPaidToolCount: Int
    public let mcpDestructiveToolCount: Int
    public let grantID: String?
    public let authorizedProjectID: String?
    public let profileID: String
    public let billingMode: String
    public let proposalHandoffEnabled: Bool
    public let externalRequest: ChatGPTExternalRequest?

    public init(
        filmCoreReady: Bool,
        mcpReady: Bool,
        tunnelReady: Bool,
        grantExpiresAt: Date?,
        mcpToolCount: Int = 0,
        mcpReadToolCount: Int = 0,
        mcpWriteToolCount: Int = 0,
        mcpPaidToolCount: Int = 0,
        mcpDestructiveToolCount: Int = 0,
        grantID: String? = nil,
        authorizedProjectID: String? = nil,
        profileID: String = "chatgpt.subscription.host.pro_readonly",
        billingMode: String = "subscription_host_no_extra_model_api",
        proposalHandoffEnabled: Bool = false,
        externalRequest: ChatGPTExternalRequest? = nil
    ) {
        self.filmCoreReady = filmCoreReady
        self.mcpReady = mcpReady
        self.tunnelReady = tunnelReady
        self.grantExpiresAt = grantExpiresAt
        self.mcpToolCount = mcpToolCount
        self.mcpReadToolCount = mcpReadToolCount
        self.mcpWriteToolCount = mcpWriteToolCount
        self.mcpPaidToolCount = mcpPaidToolCount
        self.mcpDestructiveToolCount = mcpDestructiveToolCount
        self.grantID = grantID
        self.authorizedProjectID = authorizedProjectID
        self.profileID = profileID
        self.billingMode = billingMode
        self.proposalHandoffEnabled = proposalHandoffEnabled
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
    public var mcpReadToolCount: Int
    public var mcpWriteToolCount: Int
    public var mcpPaidToolCount: Int
    public var mcpDestructiveToolCount: Int
    public var authorizedProjectID: String?
    public var grantID: String?
    public var grantExpiresAt: Date?
    public var profileID: String
    public var billingMode: String
    public var proposalHandoffEnabled: Bool
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
        mcpReadToolCount: 0,
        mcpWriteToolCount: 0,
        mcpPaidToolCount: 0,
        mcpDestructiveToolCount: 0,
        authorizedProjectID: nil,
        grantID: nil,
        grantExpiresAt: nil,
        profileID: "chatgpt.subscription.host.pro_readonly",
        billingMode: "subscription_host_no_extra_model_api",
        proposalHandoffEnabled: false,
        lastError: nil,
        lastConnectedAt: nil,
        lastExternalRequest: nil,
        liveGateChallengeID: nil
    )
}

public struct ChatGPTHostConnectionConfig: Equatable, Codable, Sendable {
    public let tunnelID: String
    public let autoConnect: Bool
    public let connectionID: String

    public init(tunnelID: String, autoConnect: Bool, connectionID: String = "chatgpt.subscription.host") {
        self.tunnelID = tunnelID
        self.autoConnect = autoConnect
        self.connectionID = connectionID
    }
}

public struct ChatGPTProjectHostSession: Equatable, Codable, Sendable {
    public let projectID: String
    public let canvasID: String?
    public let grantID: String?
    public let expiresAt: Date?
    public let contextReceiptID: String?
    public let lastExternalObservation: ChatGPTExternalRequest?

    public init(projectID: String, canvasID: String? = nil, grantID: String? = nil, expiresAt: Date? = nil, contextReceiptID: String? = nil, lastExternalObservation: ChatGPTExternalRequest? = nil) {
        self.projectID = projectID
        self.canvasID = canvasID
        self.grantID = grantID
        self.expiresAt = expiresAt
        self.contextReceiptID = contextReceiptID
        self.lastExternalObservation = lastExternalObservation
    }
}

private struct LegacyStoredChatGPTConnection: Codable {
    let tunnelID: String
    let projectID: String
    let autoConnect: Bool
}

@MainActor
public protocol ChatGPTConnectionPreferencesStoring: AnyObject {
    func loadConnectionConfig() -> ChatGPTHostConnectionConfig?
    func saveConnectionConfig(_ value: ChatGPTHostConnectionConfig)
    func loadProjectSession() -> ChatGPTProjectHostSession?
    func saveProjectSession(_ value: ChatGPTProjectHostSession)
    func clearProjectSession()
    func clear()
}

@MainActor
public final class UserDefaultsChatGPTConnectionPreferences: ChatGPTConnectionPreferencesStoring {
    private let defaults: UserDefaults
    private let connectionKey: String
    private let sessionKey: String
    private let legacyKey: String

    public init(defaults: UserDefaults = .standard, key: String = "filmos.chatgpt.host.connection.v2") {
        self.defaults = defaults
        connectionKey = key
        sessionKey = "filmos.chatgpt.host.project-session.v2"
        legacyKey = "filmos.chatgpt.connection.v1"
    }

    public func loadConnectionConfig() -> ChatGPTHostConnectionConfig? {
        migrateLegacyIfNeeded()
        guard let data = defaults.data(forKey: connectionKey) else { return nil }
        return try? JSONDecoder().decode(ChatGPTHostConnectionConfig.self, from: data)
    }

    public func saveConnectionConfig(_ value: ChatGPTHostConnectionConfig) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        defaults.set(data, forKey: connectionKey)
    }

    public func loadProjectSession() -> ChatGPTProjectHostSession? {
        migrateLegacyIfNeeded()
        guard let data = defaults.data(forKey: sessionKey) else { return nil }
        return try? JSONDecoder().decode(ChatGPTProjectHostSession.self, from: data)
    }

    public func saveProjectSession(_ value: ChatGPTProjectHostSession) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        defaults.set(data, forKey: sessionKey)
    }

    public func clear() {
        defaults.removeObject(forKey: connectionKey)
        defaults.removeObject(forKey: sessionKey)
        defaults.removeObject(forKey: legacyKey)
    }

    public func clearProjectSession() {
        defaults.removeObject(forKey: sessionKey)
    }

    private func migrateLegacyIfNeeded() {
        guard defaults.data(forKey: connectionKey) == nil,
              let data = defaults.data(forKey: legacyKey),
              let legacy = try? JSONDecoder().decode(LegacyStoredChatGPTConnection.self, from: data) else { return }
        saveConnectionConfig(ChatGPTHostConnectionConfig(tunnelID: legacy.tunnelID, autoConnect: legacy.autoConnect))
        saveProjectSession(ChatGPTProjectHostSession(projectID: legacy.projectID))
        // 保留 V1 原值供一版回滚读取；V2 已存在后不会重复迁移或覆盖用户的新设置。
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
    func revokeProjectSession() async
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
    private var currentConfiguration: ChatGPTHostConnectionConfig?
    private var currentProjectSession: ChatGPTProjectHostSession?

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

    public var savedConfiguration: ChatGPTHostConnectionConfig? { preferences.loadConnectionConfig() }
    public var activeProjectSession: ChatGPTProjectHostSession? { currentProjectSession ?? preferences.loadProjectSession() }

    public func connect(tunnelID: String, runtimeKey: String, projectID: String) async throws {
        let configuration = try Self.validatedConnectionConfig(tunnelID: tunnelID)
        let projectSession = try Self.validatedProjectSession(projectID: projectID)
        let key = try Self.validatedRuntimeKey(runtimeKey)
        try tokenStore.store(key, for: .openAIMCPTunnelRuntimeKey)
        preferences.saveConnectionConfig(configuration)
        preferences.saveProjectSession(projectSession)
        currentRuntimeKey = key
        try await establish(configuration: configuration, projectSession: projectSession, resetChallenge: currentChallengeID == nil)
    }

    public func activateProject(projectID: String, canvasID: String? = nil, contextReceiptID: String? = nil) async throws {
        let next = try Self.validatedProjectSession(projectID: projectID, canvasID: canvasID, contextReceiptID: contextReceiptID)
        if currentProjectSession?.projectID == next.projectID {
            currentProjectSession = ChatGPTProjectHostSession(
                projectID: next.projectID,
                canvasID: next.canvasID,
                grantID: currentProjectSession?.grantID,
                expiresAt: currentProjectSession?.expiresAt,
                contextReceiptID: next.contextReceiptID,
                lastExternalObservation: currentProjectSession?.lastExternalObservation
            )
            preferences.saveProjectSession(currentProjectSession!)
            return
        }
        preferences.saveProjectSession(next)
        currentProjectSession = next
        guard desiredConnection, let configuration = currentConfiguration ?? preferences.loadConnectionConfig() else { return }
        let key = try currentRuntimeKey ?? tokenStore.loadString(for: .openAIMCPTunnelRuntimeKey)
        currentRuntimeKey = try Self.validatedRuntimeKey(key)
        operations.stopTunnel()
        try await establish(configuration: configuration, projectSession: next, resetChallenge: true)
    }

    public func deactivateProject() async {
        monitorTask?.cancel()
        monitorTask = nil
        await operations.revokeProjectSession()
        currentProjectSession = nil
        preferences.clearProjectSession()
        snapshot = .notConfigured
    }

    public func autoConnectIfConfigured() async {
        guard let configuration = preferences.loadConnectionConfig(), configuration.autoConnect,
              let projectSession = preferences.loadProjectSession() else { return }
        do {
            let key = try tokenStore.loadString(for: .openAIMCPTunnelRuntimeKey)
            currentRuntimeKey = try Self.validatedRuntimeKey(key)
            try await establish(configuration: configuration, projectSession: projectSession, resetChallenge: true)
        } catch {
            fail(error)
        }
    }

    public func reconnect() async throws {
        guard let configuration = currentConfiguration ?? preferences.loadConnectionConfig(),
              let projectSession = currentProjectSession ?? preferences.loadProjectSession() else {
            throw ChatGPTConnectionError.invalidTunnelID
        }
        let key = try currentRuntimeKey ?? tokenStore.loadString(for: .openAIMCPTunnelRuntimeKey)
        currentRuntimeKey = try Self.validatedRuntimeKey(key)
        operations.stopTunnel()
        try await establish(configuration: configuration, projectSession: projectSession, resetChallenge: false)
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
        currentProjectSession = nil
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
        guard let configuration = currentConfiguration, let projectSession = currentProjectSession, let runtimeKey = currentRuntimeKey else {
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
        仅通过已连接的 FilmOS Studio MCP 读取项目 \(projectSession.projectID)。
        读取 Project、ContentUnit、Scene、DirectorUnit、Shot、SceneTwin、Asset、GenerationAttempt 以及 QC/Approval 状态；不得根据本提示猜测，不得调用写工具。
        回答时带上 Challenge ID，并说明读取到的对象 ID 与状态。
        """
        return prompt
    }

    public func diagnosticReport() async -> String {
        let health = await operations.runtimeHealth()
        let tunnelIDPresent = preferences.loadConnectionConfig()?.tunnelID.isEmpty == false
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

    private func establish(configuration: ChatGPTHostConnectionConfig, projectSession: ChatGPTProjectHostSession, resetChallenge: Bool) async throws {
        monitorTask?.cancel()
        desiredConnection = true
        currentConfiguration = configuration
        currentProjectSession = projectSession
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
            try await operations.prepareLocalServices(projectID: projectSession.projectID, transportProof: transportProof)
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
                       let projectSession = self.currentProjectSession,
                       let runtimeKey = self.currentRuntimeKey,
                       let transportProof = self.currentTransportProof,
                       let challengeID = self.currentChallengeID {
                        do {
                            try await self.operations.prepareLocalServices(
                                projectID: projectSession.projectID,
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
        snapshot.mcpReadToolCount = health.mcpReadToolCount
        snapshot.mcpWriteToolCount = health.mcpWriteToolCount
        snapshot.mcpPaidToolCount = health.mcpPaidToolCount
        snapshot.mcpDestructiveToolCount = health.mcpDestructiveToolCount
        snapshot.authorizedProjectID = health.authorizedProjectID
        snapshot.grantID = health.grantID
        snapshot.grantExpiresAt = health.grantExpiresAt
        snapshot.profileID = health.profileID
        snapshot.billingMode = health.billingMode
        snapshot.proposalHandoffEnabled = health.proposalHandoffEnabled
        snapshot.grantStatus = grantIsValid(health.grantExpiresAt) ? .pass : .expired
        snapshot.billingStatus = .zero
        let externalRequest = validExternalRequest(health)
        snapshot.lastExternalRequest = externalRequest
        if let current = currentProjectSession {
            let updated = ChatGPTProjectHostSession(
                projectID: current.projectID,
                canvasID: current.canvasID,
                grantID: health.grantID,
                expiresAt: health.grantExpiresAt,
                contextReceiptID: current.contextReceiptID,
                lastExternalObservation: externalRequest
            )
            currentProjectSession = updated
            preferences.saveProjectSession(updated)
        }
        if let request = externalRequest {
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

    private func validExternalRequest(_ health: ChatGPTRuntimeHealth) -> ChatGPTExternalRequest? {
        guard health.tunnelReady, let request = health.externalRequest,
              let projectID = currentProjectSession?.projectID,
              request.projectScope == projectID,
              health.authorizedProjectID == projectID,
              (request.expiresAt?.timeIntervalSinceNow ?? 1) > 0 else { return nil }
        return request
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

    private static func validatedConnectionConfig(tunnelID: String) throws -> ChatGPTHostConnectionConfig {
        let tunnelID = tunnelID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard tunnelID.range(of: "^tunnel_[A-Za-z0-9_-]{8,128}$", options: .regularExpression) != nil else {
            throw ChatGPTConnectionError.invalidTunnelID
        }
        return ChatGPTHostConnectionConfig(tunnelID: tunnelID, autoConnect: true)
    }

    private static func validatedProjectSession(projectID: String, canvasID: String? = nil, contextReceiptID: String? = nil) throws -> ChatGPTProjectHostSession {
        let projectID = projectID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard projectID.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", options: .regularExpression) != nil else {
            throw ChatGPTConnectionError.projectRequired
        }
        return ChatGPTProjectHostSession(projectID: projectID, canvasID: canvasID, contextReceiptID: contextReceiptID)
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
