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
        #expect(manager.snapshot.mcpWriteToolCount == 0)
        #expect(tokens.values[.openAIMCPTunnelRuntimeKey] == Data("runtime-key-never-log".utf8))
        #expect(preferences.value?.tunnelID == "tunnel_12345678")
        #expect(try JSONEncoder().encode(preferences.value).contains(Data("runtime-key-never-log".utf8)) == false)
        #expect(operations.lastRuntimeKey == "runtime-key-never-log")
        #expect(operations.lastTunnelArgumentsContainRuntimeKey == false)
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
            toolName: "filmos_get_project_context",
            requestID: "request-1",
            projectScope: "host-project-1",
            challengeID: "live_12345678",
            resultHash: String(repeating: "a", count: 64)
        )

        await manager.refresh()

        #expect(manager.snapshot.state == .chatGPTReachedFilmOS)
        #expect(manager.snapshot.chatgptReachabilityStatus == .connected)
        #expect(manager.snapshot.lastExternalRequest?.toolName == "filmos_get_project_context")
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
        try await Task.sleep(for: .milliseconds(80))

        #expect(operations.startCount > initialStarts)
        #expect(operations.stopCount > 0)
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
        try await Task.sleep(for: .milliseconds(80))

        #expect(operations.prepareCount > initialPrepareCount)
        #expect(operations.lastPreparedProjectID == "host-project-1")
        #expect(operations.health.grantExpiresAt?.timeIntervalSinceNow ?? 0 > 300)
        #expect(operations.stopCount > 0)
        manager.disconnect()
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
    var value: StoredChatGPTConnection?
    func load() -> StoredChatGPTConnection? { value }
    func save(_ value: StoredChatGPTConnection) { self.value = value }
    func clear() { value = nil }
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

    func prepareLocalServices(projectID: String, transportProof: String) async throws {
        prepareCount += 1
        lastPreparedProjectID = projectID
        health.filmCoreReady = true
        health.mcpReady = true
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

    func runtimeHealth() async -> ChatGPTRuntimeHealth { health.value }
}

@MainActor
private final class MutableHealth {
    var filmCoreReady = true
    var mcpReady = true
    var tunnelReady = false
    var grantExpiresAt: Date? = Date().addingTimeInterval(900)
    var mcpToolCount = 20
    var mcpWriteToolCount = 0
    var externalRequest: ChatGPTExternalRequest?

    var value: ChatGPTRuntimeHealth {
        ChatGPTRuntimeHealth(
            filmCoreReady: filmCoreReady,
            mcpReady: mcpReady,
            tunnelReady: tunnelReady,
            grantExpiresAt: grantExpiresAt,
            mcpToolCount: mcpToolCount,
            mcpWriteToolCount: mcpWriteToolCount,
            externalRequest: externalRequest
        )
    }
}

private extension Data {
    func contains(_ other: Data) -> Bool {
        range(of: other) != nil
    }
}
