import Foundation

public struct LocalDataLayout: Equatable, Sendable {
    public let rootURL: URL
    public let runtimeStateURL: URL
    public let processLogsURL: URL
    public let migrationStagingURL: URL
    public let bookmarkStateURL: URL

    public init(applicationSupportRoot: URL) throws {
        let base = applicationSupportRoot.standardizedFileURL
        guard base.isFileURL, base.path.hasPrefix("/"), base.path != "/" else {
            throw LocalDataLayoutError.invalidApplicationSupportRoot
        }

        rootURL = base.appendingPathComponent("FilmOS Studio", isDirectory: true)
        runtimeStateURL = rootURL.appendingPathComponent("Runtime", isDirectory: true)
        processLogsURL = rootURL.appendingPathComponent("Logs", isDirectory: true)
        migrationStagingURL = rootURL.appendingPathComponent("MigrationStaging", isDirectory: true)
        bookmarkStateURL = rootURL.appendingPathComponent("Bookmarks", isDirectory: true)
    }

    public static func resolve(fileManager: FileManager = .default) throws -> LocalDataLayout {
        guard let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw LocalDataLayoutError.applicationSupportUnavailable
        }
        return try LocalDataLayout(applicationSupportRoot: base)
    }

    public func prepareDirectories(fileManager: FileManager = .default) throws {
        for directory in [rootURL, runtimeStateURL, processLogsURL, migrationStagingURL, bookmarkStateURL] {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        }
    }
}

public enum LocalDataLayoutError: Error, Equatable, LocalizedError {
    case applicationSupportUnavailable
    case invalidApplicationSupportRoot

    public var errorDescription: String? {
        switch self {
        case .applicationSupportUnavailable:
            "The user Application Support directory is unavailable."
        case .invalidApplicationSupportRoot:
            "The Application Support root must be an absolute non-root file URL."
        }
    }
}
