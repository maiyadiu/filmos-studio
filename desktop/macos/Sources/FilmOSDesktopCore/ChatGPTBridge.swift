import Foundation

public struct LoopbackEndpoint: Equatable, Sendable {
    public let baseURL: URL

    public init(_ baseURL: URL) throws {
        guard
            baseURL.scheme?.lowercased() == "http",
            let host = baseURL.host?.lowercased(),
            host == "127.0.0.1" || host == "::1" || host == "localhost",
            let port = baseURL.port,
            (1...65_535).contains(port),
            baseURL.user == nil,
            baseURL.password == nil,
            baseURL.query == nil,
            baseURL.fragment == nil
        else {
            throw ChatGPTBridgeError.nonLoopbackEndpoint
        }

        let normalizedPath = baseURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard normalizedPath.isEmpty else {
            throw ChatGPTBridgeError.nonLoopbackEndpoint
        }
        self.baseURL = baseURL
    }

    public func url(path: String) throws -> URL {
        guard
            path.hasPrefix("/"),
            !path.hasPrefix("//"),
            !path.contains("?"),
            !path.contains("#"),
            !path.split(separator: "/").contains("..")
        else {
            throw ChatGPTBridgeError.invalidPath
        }
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw ChatGPTBridgeError.invalidPath
        }
        return url
    }
}

public enum ChatGPTBridgeState: Equatable, Sendable {
    case disabled
    case disconnected
    case connecting
    case localServiceReady
    case degraded(reason: String)
    case revoked
}

public struct ChatGPTBridgeHealth: Equatable, Sendable {
    public let proposalHandoffEnabled: Bool
    public let reportedExternalAccountConnected: Bool

    public init(proposalHandoffEnabled: Bool, reportedExternalAccountConnected: Bool) {
        self.proposalHandoffEnabled = proposalHandoffEnabled
        self.reportedExternalAccountConnected = reportedExternalAccountConnected
    }
}

public enum ChatGPTBridgeError: Error, Equatable, LocalizedError {
    case disabled
    case nonLoopbackEndpoint
    case invalidPath
    case invalidResponse
    case unauthorized
    case unavailable

    public var errorDescription: String? {
        switch self {
        case .disabled:
            "The ChatGPT bridge is disabled."
        case .nonLoopbackEndpoint:
            "The desktop bridge may connect only to an explicit loopback HTTP endpoint."
        case .invalidPath:
            "The loopback bridge path is invalid."
        case .invalidResponse:
            "The loopback bridge returned an invalid response."
        case .unauthorized:
            "The loopback bridge health probe was rejected."
        case .unavailable:
            "The loopback bridge is unavailable."
        }
    }
}

public protocol LoopbackBridgeTransporting: Sendable {
    func probe(endpoint: LoopbackEndpoint) async throws -> ChatGPTBridgeHealth
}

public final class URLSessionLoopbackBridgeTransport: LoopbackBridgeTransporting, @unchecked Sendable {
    public init() {}

    public func probe(endpoint: LoopbackEndpoint) async throws -> ChatGPTBridgeHealth {
        let request = try Self.healthRequest(endpoint: endpoint)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: RejectRedirectDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw ChatGPTBridgeError.invalidResponse
            }
            switch http.statusCode {
            case 200..<300:
                guard let health = Self.parseHealthPayload(data) else {
                    throw ChatGPTBridgeError.invalidResponse
                }
                return health
            case 401, 403:
                throw ChatGPTBridgeError.unauthorized
            default:
                throw ChatGPTBridgeError.unavailable
            }
        } catch let error as ChatGPTBridgeError {
            throw error
        } catch {
            throw ChatGPTBridgeError.unavailable
        }
    }

    static func healthRequest(endpoint: LoopbackEndpoint) throws -> URLRequest {
        var request = URLRequest(url: try endpoint.url(path: "/health"))
        request.httpMethod = "GET"
        request.timeoutInterval = 5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    static func acceptsHealthPayload(_ data: Data) -> Bool {
        parseHealthPayload(data) != nil
    }

    private static func parseHealthPayload(_ data: Data) -> ChatGPTBridgeHealth? {
        guard
            let health = try? JSONDecoder().decode(BridgeHealth.self, from: data),
            health.ok,
            health.feature == "film.chatgpt_app",
            health.enabled,
            !health.publicListener
        else {
            return nil
        }
        return ChatGPTBridgeHealth(
            proposalHandoffEnabled: health.proposalHandoffEnabled,
            reportedExternalAccountConnected: health.externalAccountConnected
        )
    }
}

private struct BridgeHealth: Decodable {
    let ok: Bool
    let feature: String
    let enabled: Bool
    let proposalHandoffEnabled: Bool
    let publicListener: Bool
    let externalAccountConnected: Bool

    enum CodingKeys: String, CodingKey {
        case ok
        case feature
        case enabled
        case proposalHandoffEnabled = "proposal_handoff_enabled"
        case publicListener = "public_listener"
        case externalAccountConnected = "external_account_connected"
    }
}

private final class RejectRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

public actor ChatGPTBridgeController {
    public private(set) var state: ChatGPTBridgeState
    public private(set) var reportedExternalAccountConnected: Bool?

    private let enabled: Bool
    private let endpoint: LoopbackEndpoint
    private let tokenStore: any SecureTokenStoring
    private let transport: any LoopbackBridgeTransporting

    public init(
        enabled: Bool,
        endpoint: LoopbackEndpoint,
        tokenStore: any SecureTokenStoring = KeychainTokenStore(),
        transport: any LoopbackBridgeTransporting = URLSessionLoopbackBridgeTransport()
    ) {
        self.enabled = enabled
        self.endpoint = endpoint
        self.tokenStore = tokenStore
        self.transport = transport
        state = enabled ? .disconnected : .disabled
        reportedExternalAccountConnected = nil
    }

    public func connect() async throws {
        guard enabled else { throw ChatGPTBridgeError.disabled }
        state = .connecting
        do {
            _ = try tokenStore.load(for: .chatGPTBridgeSession)
            let health = try await transport.probe(endpoint: endpoint)
            reportedExternalAccountConnected = health.reportedExternalAccountConnected
            state = .localServiceReady
        } catch {
            reportedExternalAccountConnected = nil
            state = .degraded(reason: Self.safeReason(for: error))
            throw error
        }
    }

    public func disconnect() {
        guard enabled else {
            state = .disabled
            return
        }
        reportedExternalAccountConnected = nil
        state = .disconnected
    }

    public func revoke() throws {
        try tokenStore.delete(for: .chatGPTBridgeSession)
        reportedExternalAccountConnected = nil
        state = .revoked
    }

    private static func safeReason(for error: Error) -> String {
        switch error {
        case SecureTokenStoreError.tokenNotFound:
            "session_token_missing"
        case ChatGPTBridgeError.unauthorized:
            "loopback_probe_rejected"
        case ChatGPTBridgeError.unavailable:
            "loopback_unavailable"
        default:
            "bridge_connection_failed"
        }
    }
}
