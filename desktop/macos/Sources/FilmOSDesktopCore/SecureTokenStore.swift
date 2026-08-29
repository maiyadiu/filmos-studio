import Foundation
import Security

public struct SecureTokenKey: Hashable, Sendable {
    public let service: String
    public let account: String

    public init(service: String, account: String) throws {
        guard Self.isSafeComponent(service), Self.isSafeComponent(account) else {
            throw SecureTokenStoreError.invalidKey
        }
        self.service = service
        self.account = account
    }

    public static let chatGPTBridgeSession = try! SecureTokenKey(
        service: "com.filmos.studio.chatgpt",
        account: "bridge-session-token"
    )

    public static let proposalSigningSecret = try! SecureTokenKey(
        service: "com.filmos.studio.chatgpt",
        account: "proposal-signing-secret"
    )

    public static let openAIMCPTunnelRuntimeKey = try! SecureTokenKey(
        service: "com.filmos.studio.openai-mcp-tunnel",
        account: "runtime-key"
    )

    private static func isSafeComponent(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil
    }
}

public enum SecureTokenStoreError: Error, Equatable, LocalizedError {
    case invalidKey
    case emptyToken
    case tokenTooLarge
    case tokenNotFound
    case invalidTokenEncoding
    case keychainFailure(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .invalidKey:
            "The Keychain service or account is invalid."
        case .emptyToken:
            "The secure token is empty."
        case .tokenTooLarge:
            "The secure token is too large."
        case .tokenNotFound:
            "The secure token is not available."
        case .invalidTokenEncoding:
            "The secure token is not valid UTF-8."
        case let .keychainFailure(status):
            "Keychain operation failed with status \(status)."
        }
    }
}

public protocol SecureTokenStoring: Sendable {
    func store(_ token: Data, for key: SecureTokenKey) throws
    func load(for key: SecureTokenKey) throws -> Data
    func delete(for key: SecureTokenKey) throws
}

public extension SecureTokenStoring {
    func store(_ token: String, for key: SecureTokenKey) throws {
        guard let data = token.data(using: .utf8) else {
            throw SecureTokenStoreError.invalidTokenEncoding
        }
        try store(data, for: key)
    }

    func loadString(for key: SecureTokenKey) throws -> String {
        let data = try load(for: key)
        guard let value = String(data: data, encoding: .utf8) else {
            throw SecureTokenStoreError.invalidTokenEncoding
        }
        return value
    }
}

public final class KeychainTokenStore: SecureTokenStoring, @unchecked Sendable {
    private let accessGroup: String?

    public init(accessGroup: String? = nil) {
        self.accessGroup = accessGroup
    }

    public func store(_ token: Data, for key: SecureTokenKey) throws {
        guard !token.isEmpty else { throw SecureTokenStoreError.emptyToken }
        guard token.count <= 16_384 else { throw SecureTokenStoreError.tokenTooLarge }

        var lookup = baseQuery(for: key)
        let attributes: [CFString: Any] = [
            kSecValueData: token,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(lookup as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw SecureTokenStoreError.keychainFailure(updateStatus)
        }

        for (attribute, value) in attributes {
            lookup[attribute] = value
        }
        let addStatus = SecItemAdd(lookup as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw SecureTokenStoreError.keychainFailure(addStatus)
        }
    }

    public func load(for key: SecureTokenKey) throws -> Data {
        var query = baseQuery(for: key)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { throw SecureTokenStoreError.tokenNotFound }
        guard status == errSecSuccess else {
            throw SecureTokenStoreError.keychainFailure(status)
        }
        guard let data = result as? Data, !data.isEmpty else {
            throw SecureTokenStoreError.invalidTokenEncoding
        }
        return data
    }

    public func delete(for key: SecureTokenKey) throws {
        let status = SecItemDelete(baseQuery(for: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SecureTokenStoreError.keychainFailure(status)
        }
    }

    private func baseQuery(for key: SecureTokenKey) -> [CFString: Any] {
        var query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: key.service,
            kSecAttrAccount: key.account,
            kSecAttrSynchronizable: kCFBooleanFalse as Any,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup] = accessGroup
        }
        return query
    }
}
