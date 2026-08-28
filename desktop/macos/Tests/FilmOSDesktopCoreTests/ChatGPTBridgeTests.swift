import Foundation
import Testing

@testable import FilmOSDesktopCore

@Suite
struct ChatGPTBridgeTests {
    @Test
    func endpointAllowsOnlyExplicitLoopbackHTTPRoot() throws {
        let endpoint = try LoopbackEndpoint(URL(string: "http://127.0.0.1:43123")!)
        #expect(try endpoint.url(path: "/health").absoluteString == "http://127.0.0.1:43123/health")

        for value in [
            "https://127.0.0.1:43123",
            "http://0.0.0.0:43123",
            "http://192.168.1.10:43123",
            "http://127.0.0.1",
            "http://user:password@127.0.0.1:43123",
            "http://127.0.0.1:43123/api",
        ] {
            #expect(throws: ChatGPTBridgeError.nonLoopbackEndpoint) {
                _ = try LoopbackEndpoint(URL(string: value)!)
            }
        }
        #expect(throws: ChatGPTBridgeError.invalidPath) {
            _ = try endpoint.url(path: "//remote.example/health")
        }
        #expect(throws: ChatGPTBridgeError.invalidPath) {
            _ = try endpoint.url(path: "/../secret")
        }
    }

    @Test
    func healthPayloadRequiresFeatureIdentityAndNoPublicListener() throws {
        let endpoint = try LoopbackEndpoint(URL(string: "http://127.0.0.1:43123")!)
        let request = try URLSessionLoopbackBridgeTransport.healthRequest(endpoint: endpoint)
        #expect(request.url?.path == "/health")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(URLSessionLoopbackBridgeTransport.acceptsHealthPayload(
            Data(#"{"ok":true,"feature":"film.chatgpt_app","enabled":true,"proposal_handoff_enabled":true,"public_listener":false,"external_account_connected":false}"#.utf8)
        ))
        #expect(!URLSessionLoopbackBridgeTransport.acceptsHealthPayload(
            Data(#"{"ok":true,"feature":"film.chatgpt_app","enabled":true,"proposal_handoff_enabled":true,"public_listener":true,"external_account_connected":false}"#.utf8)
        ))
        #expect(!URLSessionLoopbackBridgeTransport.acceptsHealthPayload(
            Data(#"{"ok":true,"feature":"different","enabled":true,"proposal_handoff_enabled":true,"public_listener":false,"external_account_connected":false}"#.utf8)
        ))
        #expect(!URLSessionLoopbackBridgeTransport.acceptsHealthPayload(
            Data(#"{"ok":true,"feature":"film.chatgpt_app","enabled":false,"proposal_handoff_enabled":true,"public_listener":false,"external_account_connected":false}"#.utf8)
        ))
        #expect(!URLSessionLoopbackBridgeTransport.acceptsHealthPayload(Data(#"{"ok":true}"#.utf8)))
    }

    @Test
    func controllerLoadsTokenFromSecureStoreAndTransitionsState() async throws {
        let store = MemorySecureTokenStore()
        try store.store("short-lived-session", for: .chatGPTBridgeSession)
        let transport = RecordingBridgeTransport()
        let controller = try ChatGPTBridgeController(
            enabled: true,
            endpoint: LoopbackEndpoint(URL(string: "http://localhost:43123")!),
            tokenStore: store,
            transport: transport
        )

        #expect(await controller.state == .disconnected)
        try await controller.connect()
        #expect(await controller.state == .localServiceReady)
        #expect(await controller.reportedExternalAccountConnected == false)
        #expect(await transport.probeCount == 1)

        await controller.disconnect()
        #expect(await controller.state == .disconnected)
        try await controller.revoke()
        #expect(await controller.state == .revoked)
        #expect(throws: SecureTokenStoreError.tokenNotFound) {
            try store.load(for: .chatGPTBridgeSession)
        }
    }

    @Test
    func missingTokenDegradesWithoutEmbeddingSecretsInState() async throws {
        let controller = try ChatGPTBridgeController(
            enabled: true,
            endpoint: LoopbackEndpoint(URL(string: "http://127.0.0.1:43123")!),
            tokenStore: MemorySecureTokenStore(),
            transport: RecordingBridgeTransport()
        )

        await #expect(throws: SecureTokenStoreError.tokenNotFound) {
            try await controller.connect()
        }
        #expect(await controller.state == .degraded(reason: "session_token_missing"))
    }

    @Test
    func disabledBridgeNeverContactsTransport() async throws {
        let transport = RecordingBridgeTransport()
        let controller = try ChatGPTBridgeController(
            enabled: false,
            endpoint: LoopbackEndpoint(URL(string: "http://127.0.0.1:43123")!),
            tokenStore: MemorySecureTokenStore(),
            transport: transport
        )

        await #expect(throws: ChatGPTBridgeError.disabled) {
            try await controller.connect()
        }
        #expect(await controller.state == .disabled)
        #expect(await transport.probeCount == 0)
    }
}

private actor RecordingBridgeTransport: LoopbackBridgeTransporting {
    private(set) var probeCount = 0

    func probe(endpoint: LoopbackEndpoint) async throws -> ChatGPTBridgeHealth {
        probeCount += 1
        return ChatGPTBridgeHealth(proposalHandoffEnabled: true, reportedExternalAccountConnected: false)
    }
}
