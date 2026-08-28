import Foundation

public struct InternalWorkbenchConfiguration: Equatable, Sendable {
    public static let currentSchemaVersion = 2

    public let startURL: URL
    public let webHealthURL: URL
    public let backendHealthURL: URL
    public let applicationSupportDirectoryName: String
    public let backendDataDirectoryName: String

    public static func decode(_ data: Data) throws -> InternalWorkbenchConfiguration {
        let payload: Payload
        do {
            payload = try JSONDecoder().decode(Payload.self, from: data)
        } catch {
            throw InternalWorkbenchConfigurationError.invalidJSON
        }

        guard payload.schemaVersion == currentSchemaVersion else {
            throw InternalWorkbenchConfigurationError.unsupportedSchema
        }

        let applicationSupportDirectoryName = try directoryName(payload.applicationSupportDirectoryName)
        let backendDataDirectoryName = try directoryName(payload.backendDataDirectoryName)

        let startURL = try loopbackHTTPURL(payload.startURL)
        let webHealthURL = try loopbackHTTPURL(payload.webHealthURL)
        let backendHealthURL = try loopbackHTTPURL(payload.backendHealthURL)
        guard sameOrigin(startURL, webHealthURL) else {
            throw InternalWorkbenchConfigurationError.inconsistentWebOrigin
        }

        return InternalWorkbenchConfiguration(
            startURL: startURL,
            webHealthURL: webHealthURL,
            backendHealthURL: backendHealthURL,
            applicationSupportDirectoryName: applicationSupportDirectoryName,
            backendDataDirectoryName: backendDataDirectoryName
        )
    }

    public static func load(from url: URL) throws -> InternalWorkbenchConfiguration {
        try decode(Data(contentsOf: url))
    }

    private struct Payload: Decodable {
        let schemaVersion: Int
        let startURL: String
        let webHealthURL: String
        let backendHealthURL: String
        let applicationSupportDirectoryName: String
        let backendDataDirectoryName: String

        enum CodingKeys: String, CodingKey {
            case schemaVersion = "schema_version"
            case startURL = "start_url"
            case webHealthURL = "web_health_url"
            case backendHealthURL = "backend_health_url"
            case applicationSupportDirectoryName = "application_support_directory_name"
            case backendDataDirectoryName = "backend_data_directory_name"
        }
    }

    private static func directoryName(_ value: String) throws -> String {
        guard
            value == value.trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty,
            value != ".",
            value != "..",
            !value.contains("/"),
            !value.contains(":"),
            !value.contains("\0")
        else {
            throw InternalWorkbenchConfigurationError.invalidDirectoryName
        }
        return value
    }

    private static func loopbackHTTPURL(_ rawValue: String) throws -> URL {
        guard
            let components = URLComponents(string: rawValue),
            components.scheme?.lowercased() == "http",
            let host = components.host?.lowercased(),
            ["127.0.0.1", "localhost", "::1"].contains(host),
            components.user == nil,
            components.password == nil,
            components.fragment == nil,
            let url = components.url
        else {
            throw InternalWorkbenchConfigurationError.invalidLoopbackURL
        }
        return url
    }

    private static func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
        guard let lhs = URLComponents(url: lhs, resolvingAgainstBaseURL: false),
              let rhs = URLComponents(url: rhs, resolvingAgainstBaseURL: false)
        else {
            return false
        }
        return lhs.scheme?.lowercased() == rhs.scheme?.lowercased()
            && lhs.host?.lowercased() == rhs.host?.lowercased()
            && (lhs.port ?? 80) == (rhs.port ?? 80)
    }

}

public enum InternalWorkbenchConfigurationError: Error, Equatable, LocalizedError {
    case invalidJSON
    case unsupportedSchema
    case invalidDirectoryName
    case invalidLoopbackURL
    case inconsistentWebOrigin

    public var errorDescription: String? {
        switch self {
        case .invalidJSON:
            "Internal workbench configuration is invalid."
        case .unsupportedSchema:
            "Internal workbench configuration version is unsupported."
        case .invalidDirectoryName:
            "Internal workbench configuration contains an invalid directory name."
        case .invalidLoopbackURL:
            "Internal workbench endpoints must use loopback HTTP URLs."
        case .inconsistentWebOrigin:
            "Internal workbench start and health URLs must use the same origin."
        }
    }
}
