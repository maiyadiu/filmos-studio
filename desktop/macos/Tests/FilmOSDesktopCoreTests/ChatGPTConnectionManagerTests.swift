import Foundation
import Testing

@testable import FilmOSDesktopCore

@MainActor
@Suite
struct ChatGPTConnectionManagerTests {
    @Test
    func stoppedFilmCoreAndMCPArePreparedBeforeTunnelStarts() async throws {
        let operations = FakeConnectionOperations()
        operations.health.filmCoreReady = false
        operations.health.mcpReady = false
        let manager = ChatGPTConnectionManager(
            operations: operations,
            tokenStore: MemoryTokenStore(),
            preferences: MemoryConnectionPreferences()
        )

        try await manager.connect(
            tunnelID: "tunnel_12345678",
            runtimeKey: "runtime",
            projectID: "host-project-1"
        )

        #expect(operations.prepareCount == 1)
        #expect(operations.health.filmCoreReady)
        #expect(operations.health.mcpReady)
        #expect(operations.doctorCount == 1)
        #expect(operations.startCount == 1)
        manager.disconnect()
    }

    @Test
    func firstConnectionStoresOnlyRuntimeKeyInSecureStoreAndReachesWaitingState() async throws {
        let operations = FakeConnectionOperations()
        let tokens = MemoryTokenStore()
        let preferences = MemoryConnectionPreferences()
        let manager = ChatGPTConnectionManager(
            operations: operations,
            tokenStore: tokens,
            preferences: preferences,
            backoff: ReconnectBackoff(delays: [0.01]),
            monitorInterval: 0.02
        )

        try await manager.connect(
            tunnelID: "tunnel_12345678",
            runtimeKey: "runtime-key-never-log",
            projectID: "host-project-1"
        )

        #expect(manager.snapshot.state == .waitingForChatGPT)
        #expect(manager.snapshot.filmCoreStatus == .pass)
        #expect(manager.snapshot.mcpStatus == .pass)
        #expect(manager.snapshot.tunnelStatus == .connected)
        #expect(manager.snapshot.grantStatus == .pass)
        #expect(manager.snapshot.billingStatus == .zero)
        #expect(manager.snapshot.mcpToolCount == 20)
        #expect(manager.snapshot.mcpReadToolCount == 20)
        #expect(manager.snapshot.mcpWriteToolCount == 0)
        #expect(tokens.values[.openAIMCPTunnelRuntimeKey] == Data("runtime-key-never-log".utf8))
        #expect(preferences.configuration?.tunnelID == "tunnel_12345678")
        #expect(try JSONEncoder().encode(preferences.configuration).contains(Data("runtime-key-never-log".utf8)) == false)
        #expect(operations.lastRuntimeKey == "runtime-key-never-log")
        #expect(operations.lastTunnelArgumentsContainRuntimeKey == false)
        manager.disconnect()
    }

    @Test
    func hostContextAndHandoffUseCurrentTunnelChallengeWithoutExposingItToWebPayload() async throws {
        let operations = FakeConnectionOperations()
        let manager = ChatGPTConnectionManager(
            operations: operations,
            tokenStore: MemoryTokenStore(),
            preferences: MemoryConnectionPreferences()
        )
        try await manager.connect(tunnelID: "tunnel_12345678", runtimeKey: "runtime", projectID: "host-project-1")
        let context = Data("{\"project_id\":\"host-project-1\"}".utf8)
        let handoff = Data("{\"session_id\":\"session-1\"}".utf8)

        _ = try await manager.publishHostContext(context)
        _ = try await manager.publishPendingHostHandoff(handoff)

        #expect(operations.publishedContext == context)
        #expect(operations.publishedHandoff == handoff)
        #expect(operations.publishedChallengeID?.hasPrefix("live_") == true)
        #expect(context.contains(Data("live_".utf8)) == false)
        #expect(handoff.contains(Data("live_".utf8)) == false)
        manager.disconnect()
    }

    @Test
    func firstProvenExternalReadChangesOnlyChatGPTReachabilityState() async throws {
        let operations = FakeConnectionOperations()
        let manager = ChatGPTConnectionManager(
            operations: operations,
            tokenStore: MemoryTokenStore(),
            preferences: MemoryConnectionPreferences(),
            backoff: ReconnectBackoff(delays: [0.01]),
            monitorInterval: 0.02
        )
        try await manager.connect(tunnelID: "tunnel_12345678", runtimeKey: "runtime", projectID: "host-project-1")
        operations.health.externalRequest = ChatGPTExternalRequest(
            timestamp: Date(),
            toolName: "filmos_get_pending_agent_handoff",
            requestID: "request-1",
            projectScope: "host-project-1",
            challengeID: "live_12345678",
            resultHash: String(repeating: "a", count: 64),
            handoffID: "handoff-1"
        )

        await manager.refresh()

        #expect(manager.snapshot.state == .chatGPTReachedFilmOS)
        #expect(manager.snapshot.chatgptReachabilityStatus == .connected)
        #expect(manager.snapshot.lastExternalRequest?.toolName == "filmos_get_pending_agent_handoff")
        #expect(manager.snapshot.lastExternalRequest?.handoffID == "handoff-1")
        #expect(manager.snapshot.tunnelStatus == .connected)
        manager.disconnect()
    }

    @Test
    func monitorReconnectsWithBoundedBackoffAndDisconnectStopsOwnedTunnel() async throws {
        let operations = FakeConnectionOperations()
        let manager = ChatGPTConnectionManager(
            operations: operations,
            tokenStore: MemoryTokenStore(),
            preferences: MemoryConnectionPreferences(),
            backoff: ReconnectBackoff(delays: [0.01, 0.02]),
            monitorInterval: 0.02
        )
        try await manager.connect(tunnelID: "tunnel_12345678", runtimeKey: "runtime", projectID: "host-project-1")
        let initialStarts = operations.startCount
        operations.health.tunnelReady = false
        operations.makeTunnelReadyOnNextStart = true
        let reconnected = await waitUntil {
            operations.startCount > initialStarts && operations.stopCount > 0
        }

        #expect(reconnected)
        manager.disconnect()
        #expect(operations.stopCount > 1)
        #expect(manager.snapshot == .notConfigured)
    }

    @Test
    func expiringGrantRenewsOnlyTheCurrentProjectAndRestartsMCPBeforeTunnel() async throws {
        let operations = FakeConnectionOperations()
        let manager = ChatGPTConnectionManager(
            operations: operations,
            tokenStore: MemoryTokenStore(),
            preferences: MemoryConnectionPreferences(),
            backoff: ReconnectBackoff(delays: [0.01]),
            monitorInterval: 0.02
        )
        try await manager.connect(tunnelID: "tunnel_12345678", runtimeKey: "runtime", projectID: "host-project-1")
        let initialPrepareCount = operations.prepareCount
        operations.health.grantExpiresAt = Date().addingTimeInterval(120)
        operations.renewGrantOnPrepare = true
        let renewed = await waitUntil {
            operations.prepareCount > initialPrepareCount
                && (operations.health.grantExpiresAt?.timeIntervalSinceNow ?? 0) > 300
                && operations.stopCount > 0
        }

        #expect(renewed)
        #expect(operations.prepareCount > initialPrepareCount)
        #expect(operations.lastPreparedProjectID == "host-project-1")
        #expect(operations.health.grantExpiresAt?.timeIntervalSinceNow ?? 0 > 300)
        #expect(operations.stopCount > 0)
        manager.disconnect()
    }

    @Test
    func projectSwitchKeepsGlobalTunnelConfigButRotatesTheActiveHostSession() async throws {
        let operations = FakeConnectionOperations()
        let preferences = MemoryConnectionPreferences()
        let manager = ChatGPTConnectionManager(
            operations: operations,
            tokenStore: MemoryTokenStore(),
            preferences: preferences
        )
        try await manager.connect(tunnelID: "tunnel_12345678", runtimeKey: "runtime", projectID: "host-project-a")
        let initialStops = operations.stopCount

        try await manager.activateProject(projectID: "host-project-b", canvasID: "canvas-b", contextReceiptID: "receipt-b")

        #expect(preferences.configuration?.tunnelID == "tunnel_12345678")
        #expect(preferences.session?.projectID == "host-project-b")
        #expect(preferences.session?.canvasID == "canvas-b")
        #expect(preferences.session?.contextReceiptID == "receipt-b")
        #expect(operations.lastPreparedProjectID == "host-project-b")
        #expect(operations.stopCount > initialStops)
        manager.disconnect()
    }

    @Test
    func firstLiveWorkbenchProjectRestoresSavedAutoConnectWhenNoProjectSessionWasPersisted() async throws {
        let operations = FakeConnectionOperations()
        let tokens = MemoryTokenStore()
        try tokens.store("runtime", for: .openAIMCPTunnelRuntimeKey)
        let preferences = MemoryConnectionPreferences()
        preferences.configuration = ChatGPTHostConnectionConfig(tunnelID: "tunnel_12345678", autoConnect: true)
        let manager = ChatGPTConnectionManager(
            operations: operations,
            tokenStore: tokens,
            preferences: preferences
        )

        await manager.autoConnectIfConfigured()
        #expect(operations.prepareCount == 0)

        try await manager.activateProject(projectID: "host-project-live", canvasID: "canvas-live")

        #expect(preferences.session?.projectID == "host-project-live")
        #expect(operations.lastPreparedProjectID == "host-project-live")
        #expect(operations.startCount == 1)
        #expect(manager.snapshot.state == .waitingForChatGPT)
        manager.disconnect()
    }

    @Test
    func legacyCombinedPreferenceMigratesOnceIntoConnectionAndProjectSession() {
        let suite = "filmos-chatgpt-migration-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(Data("{\"tunnelID\":\"tunnel_12345678\",\"projectID\":\"host-project-a\",\"autoConnect\":true}".utf8), forKey: "filmos.chatgpt.connection.v1")
        let preferences = UserDefaultsChatGPTConnectionPreferences(defaults: defaults)

        #expect(preferences.loadConnectionConfig()?.tunnelID == "tunnel_12345678")
        #expect(preferences.loadConnectionConfig()?.connectionID == "chatgpt.subscription.host")
        #expect(preferences.loadProjectSession()?.projectID == "host-project-a")
        #expect(defaults.data(forKey: "filmos.chatgpt.connection.v1") != nil)
    }

    @Test
    func liveGatePreparationRotatesChallengeRestartsTunnelAndNeverCopiesRuntimeKey() async throws {
        let operations = FakeConnectionOperations()
        let manager = ChatGPTConnectionManager(
            operations: operations,
            tokenStore: MemoryTokenStore(),
            preferences: MemoryConnectionPreferences()
        )
        try await manager.connect(tunnelID: "tunnel_12345678", runtimeKey: "runtime-secret", projectID: "host-project-1")

        let prompt = try await manager.prepareLiveGate()

        #expect(prompt.contains("live_"))
        #expect(prompt.contains("host-project-1"))
        #expect(prompt.contains("runtime-secret") == false)
        #expect(manager.snapshot.liveGateChallengeID?.hasPrefix("live_") == true)
        #expect(operations.stopCount > 0)
        manager.disconnect()
    }

    @Test
    func diagnosticAndRuntimeDescriptionsRedactCredentials() async throws {
        let operations = FakeConnectionOperations()
        let manager = ChatGPTConnectionManager(
            operations: operations,
            tokenStore: MemoryTokenStore(),
            preferences: MemoryConnectionPreferences()
        )
        try await manager.connect(tunnelID: "tunnel_12345678", runtimeKey: "runtime-secret", projectID: "host-project-1")
        let report = await manager.diagnosticReport()
        let runtime = try ServiceRuntimeEnvironment(
            values: ["CONTROL_PLANE_API_KEY": "runtime-secret", "FILMOS_SECURE_TUNNEL_PROOF": "proof"],
            secretKeys: ["CONTROL_PLANE_API_KEY", "FILMOS_SECURE_TUNNEL_PROOF"]
        )

        #expect(report.contains("runtime-secret") == false)
        #expect(report.contains("Runtime Key          [REDACTED]"))
        #expect(runtime.redactedDescription.values.allSatisfy { $0 == "[REDACTED]" })
        manager.disconnect()
    }

    @Test
    func invalidConfigurationExpiredGrantAndWriteToolsFailClosed() async throws {
        let operations = FakeConnectionOperations()
        let manager = ChatGPTConnectionManager(
            operations: operations,
            tokenStore: MemoryTokenStore(),
            preferences: MemoryConnectionPreferences()
        )
        await #expect(throws: ChatGPTConnectionError.invalidTunnelID) {
            try await manager.connect(tunnelID: "not-a-tunnel", runtimeKey: "runtime", projectID: "host-project-1")
        }
        operations.health.grantExpiresAt = Date().addingTimeInterval(-1)
        await #expect(throws: ChatGPTConnectionError.grantExpired) {
            try await manager.connect(tunnelID: "tunnel_12345678", runtimeKey: "runtime", projectID: "host-project-1")
        }
        operations.health.grantExpiresAt = Date().addingTimeInterval(900)
        operations.health.mcpWriteToolCount = 1
        await #expect(throws: ChatGPTConnectionError.writeToolsExposed) {
            try await manager.connect(tunnelID: "tunnel_12345678", runtimeKey: "runtime", projectID: "host-project-1")
        }
    }

    @Test
    func tunnelDoctorFailureBlocksLaunchAndRedactsUnderlyingError() async throws {
        let operations = FakeConnectionOperations()
        operations.doctorError = ChatGPTConnectionError.tunnelDoctorFailed
        let manager = ChatGPTConnectionManager(
            operations: operations,
            tokenStore: MemoryTokenStore(),
            preferences: MemoryConnectionPreferences()
        )

        await #expect(throws: ChatGPTConnectionError.tunnelDoctorFailed) {
            try await manager.connect(
                tunnelID: "tunnel_12345678",
                runtimeKey: "runtime-never-in-diagnostics",
                projectID: "host-project-1"
            )
        }

        #expect(operations.doctorCount == 1)
        #expect(operations.startCount == 0)
        #expect(manager.snapshot.state == .tunnelFailed)
        #expect(manager.snapshot.lastError?.contains("runtime-never-in-diagnostics") == false)
        manager.disconnect()
    }
}

@MainActor
private func waitUntil(
    timeout: Duration = .seconds(2),
    condition: @escaping @MainActor () -> Bool
) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while !condition() {
        guard clock.now < deadline else { return false }
        await Task.yield()
        try? await Task.sleep(for: .milliseconds(5))
    }
    return true
}

private final class MemoryTokenStore: SecureTokenStoring, @unchecked Sendable {
    var values: [SecureTokenKey: Data] = [:]
    func store(_ token: Data, for key: SecureTokenKey) throws { values[key] = token }
    func load(for key: SecureTokenKey) throws -> Data {
        guard let value = values[key] else { throw SecureTokenStoreError.tokenNotFound }
        return value
    }
    func delete(for key: SecureTokenKey) throws { values[key] = nil }
}

@MainActor
private final class MemoryConnectionPreferences: ChatGPTConnectionPreferencesStoring {
    var configuration: ChatGPTHostConnectionConfig?
    var session: ChatGPTProjectHostSession?
    func loadConnectionConfig() -> ChatGPTHostConnectionConfig? { configuration }
    func saveConnectionConfig(_ value: ChatGPTHostConnectionConfig) { configuration = value }
    func loadProjectSession() -> ChatGPTProjectHostSession? { session }
    func saveProjectSession(_ value: ChatGPTProjectHostSession) { session = value }
    func clearProjectSession() { session = nil }
    func clear() { configuration = nil; session = nil }
}

@MainActor
private final class FakeConnectionOperations: ChatGPTConnectionOperating {
    var health = MutableHealth()
    var startCount = 0
    var stopCount = 0
    var doctorCount = 0
    var lastRuntimeKey: String?
    var lastTunnelArgumentsContainRuntimeKey = false
    var makeTunnelReadyOnNextStart = false
    var renewGrantOnPrepare = false
    var prepareCount = 0
    var lastPreparedProjectID: String?
    var doctorError: Error?
    var publishedContext: Data?
    var publishedHandoff: Data?
    var publishedChallengeID: String?

    func prepareLocalServices(projectID: String, transportProof: String) async throws {
        prepareCount += 1
        lastPreparedProjectID = projectID
        health.filmCoreReady = true
        health.mcpReady = true
        health.authorizedProjectID = projectID
        health.grantID = "grant-\(projectID)"
        if renewGrantOnPrepare {
            health.grantExpiresAt = Date().addingTimeInterval(900)
            renewGrantOnPrepare = false
        }
    }

    func runTunnelDoctor(tunnelID: String, runtimeKey: String, transportProof: String, challengeID: String) async throws {
        doctorCount += 1
        lastRuntimeKey = runtimeKey
        if let doctorError { throw doctorError }
    }

    func startTunnel(tunnelID: String, runtimeKey: String, transportProof: String, challengeID: String) throws {
        startCount += 1
        lastRuntimeKey = runtimeKey
        lastTunnelArgumentsContainRuntimeKey = false
        health.tunnelReady = true
        if makeTunnelReadyOnNextStart {
            health.tunnelReady = true
            makeTunnelReadyOnNextStart = false
        }
    }

    func stopTunnel() {
        stopCount += 1
        health.tunnelReady = false
    }

    func revokeProjectSession() async {
        stopTunnel()
        health.authorizedProjectID = nil
        health.grantID = nil
        health.externalRequest = nil
    }

    func runtimeHealth() async -> ChatGPTRuntimeHealth { health.value }

    func publishHostContext(_ context: Data, challengeID: String) async throws -> Data {
        publishedContext = context
        publishedChallengeID = challengeID
        return Data("{\"accepted\":true,\"context_receipt_id\":\"receipt-1\"}".utf8)
    }

    func publishPendingHostHandoff(_ handoff: Data, challengeID: String) async throws -> Data {
        publishedHandoff = handoff
        publishedChallengeID = challengeID
        return Data("{\"accepted\":true,\"handoff_id\":\"handoff-1\"}".utf8)
    }
}

@MainActor
private final class MutableHealth {
    var filmCoreReady = true
    var mcpReady = true
    var tunnelReady = false
    var grantExpiresAt: Date? = Date().addingTimeInterval(900)
    var mcpToolCount = 20
    var mcpReadToolCount = 20
    var mcpWriteToolCount = 0
    var mcpPaidToolCount = 0
    var mcpDestructiveToolCount = 0
    var grantID: String?
    var authorizedProjectID: String?
    var externalRequest: ChatGPTExternalRequest?

    var value: ChatGPTRuntimeHealth {
        ChatGPTRuntimeHealth(
            filmCoreReady: filmCoreReady,
            mcpReady: mcpReady,
            tunnelReady: tunnelReady,
            grantExpiresAt: grantExpiresAt,
            mcpToolCount: mcpToolCount,
            mcpReadToolCount: mcpReadToolCount,
            mcpWriteToolCount: mcpWriteToolCount,
            mcpPaidToolCount: mcpPaidToolCount,
            mcpDestructiveToolCount: mcpDestructiveToolCount,
            grantID: grantID,
            authorizedProjectID: authorizedProjectID,
            externalRequest: externalRequest
        )
    }
}

private extension Data {
    func contains(_ other: Data) -> Bool {
        range(of: other) != nil
    }
}
