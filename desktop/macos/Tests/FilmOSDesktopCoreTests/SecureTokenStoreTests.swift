import Foundation
import Testing

@testable import FilmOSDesktopCore

@Suite(.serialized)
struct SecureTokenStoreTests {
    @Test
    func keychainRoundTripUpdateAndDelete() throws {
        let store = KeychainTokenStore()
        let key = try SecureTokenKey(
            service: "com.filmos.studio.tests.\(UUID().uuidString.lowercased())",
            account: "ephemeral-token"
        )
        defer { try? store.delete(for: key) }

        try store.store("first-token", for: key)
        #expect(try store.loadString(for: key) == "first-token")

        try store.store("second-token", for: key)
        #expect(try store.loadString(for: key) == "second-token")

        try store.delete(for: key)
        #expect(throws: SecureTokenStoreError.tokenNotFound) {
            try store.load(for: key)
        }
    }

    @Test
    func rejectsInvalidKeysAndUnsafeTokenSizesBeforeKeychainAccess() throws {
        #expect(throws: SecureTokenStoreError.invalidKey) {
            _ = try SecureTokenKey(service: "com.filmos studio", account: "token")
        }

        let store = KeychainTokenStore()
        #expect(throws: SecureTokenStoreError.emptyToken) {
            try store.store(Data(), for: .chatGPTBridgeSession)
        }
        #expect(throws: SecureTokenStoreError.tokenTooLarge) {
            try store.store(Data(repeating: 1, count: 16_385), for: .chatGPTBridgeSession)
        }
    }
}
