import Foundation

public struct WorkspaceLayout: Codable, Equatable, Sendable {
    public var filmCoreDatabase: String
    public var hostSnapshot: String
    public var canvas: String
    public var mediaObjects: String
    public var mediaProxies: String
    public var sceneTwins: String
    public var prompts: String
    public var tasks: String
    public var receipts: String
    public var deliverables: String
    public var audit: String
    public var cache: String
    public var backups: String

    public init(
        filmCoreDatabase: String = "film-core.sqlite",
        hostSnapshot: String = "host-snapshot",
        canvas: String = "canvas",
        mediaObjects: String = "media/objects",
        mediaProxies: String = "media/proxies",
        sceneTwins: String = "scene-twins",
        prompts: String = "prompts",
        tasks: String = "tasks",
        receipts: String = "receipts",
        deliverables: String = "deliverables",
        audit: String = "audit",
        cache: String = "cache",
        backups: String = "backups"
    ) {
        self.filmCoreDatabase = filmCoreDatabase
        self.hostSnapshot = hostSnapshot
        self.canvas = canvas
        self.mediaObjects = mediaObjects
        self.mediaProxies = mediaProxies
        self.sceneTwins = sceneTwins
        self.prompts = prompts
        self.tasks = tasks
        self.receipts = receipts
        self.deliverables = deliverables
        self.audit = audit
        self.cache = cache
        self.backups = backups
    }

    public static let current = WorkspaceLayout()

    public var directoryPaths: [String] {
        [
            hostSnapshot,
            canvas,
            mediaObjects,
            mediaProxies,
            sceneTwins,
            prompts,
            tasks,
            receipts,
            deliverables,
            audit,
            cache,
            backups,
        ]
    }

    public var portablePaths: [String] {
        [filmCoreDatabase] + directoryPaths
    }

    fileprivate func validate() throws {
        let paths = portablePaths
        guard Set(paths).count == paths.count else {
            throw WorkspaceError.invalidRelativePath("duplicate")
        }
        for path in paths {
            try WorkspaceManager.validateRelativePath(path)
        }
        guard self == .current else {
            throw WorkspaceError.unsupportedLayout
        }
    }
}

public struct WorkspaceManifest: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public var schemaVersion: Int
    public var projectID: String
    public var displayName: String
    public var createdAt: Date
    public var updatedAt: Date
    public var layout: WorkspaceLayout

    public init(
        schemaVersion: Int = currentSchemaVersion,
        projectID: String,
        displayName: String,
        createdAt: Date,
        updatedAt: Date,
        layout: WorkspaceLayout = .current
    ) {
        self.schemaVersion = schemaVersion
        self.projectID = projectID
        self.displayName = displayName
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.layout = layout
    }

    fileprivate func validate() throws {
        guard schemaVersion == Self.currentSchemaVersion else {
            throw WorkspaceError.unsupportedSchema(schemaVersion)
        }
        guard UUID(uuidString: projectID) != nil else {
            throw WorkspaceError.invalidManifest("projectID")
        }
        try WorkspaceManager.validateDisplayName(displayName)
        guard updatedAt >= createdAt else {
            throw WorkspaceError.invalidManifest("updatedAt")
        }
        try layout.validate()
    }
}

public struct FilmWorkspace: Equatable, Sendable {
    public let rootURL: URL
    public let manifest: WorkspaceManifest

    public var manifestURL: URL {
        rootURL.appendingPathComponent(WorkspaceManager.manifestFileName, isDirectory: false)
    }

    public func url(forRelativePath path: String) throws -> URL {
        try WorkspaceManager.containedURL(forRelativePath: path, in: rootURL)
    }
}

public enum WorkspaceError: Error, Equatable, LocalizedError {
    case invalidPackageExtension
    case invalidDisplayName
    case workspaceAlreadyExists
    case workspaceNotFound
    case manifestNotFound
    case invalidManifest(String)
    case unsupportedSchema(Int)
    case unsupportedLayout
    case invalidRelativePath(String)
    case missingDirectory(String)
    case migrationDestinationExists

    public var errorDescription: String? {
        switch self {
        case .invalidPackageExtension:
            "Workspace must use the .filmproject extension."
        case .invalidDisplayName:
            "Workspace display name is invalid."
        case .workspaceAlreadyExists:
            "A workspace already exists at the destination."
        case .workspaceNotFound:
            "Workspace directory was not found."
        case .manifestNotFound:
            "Workspace manifest was not found."
        case let .invalidManifest(field):
            "Workspace manifest field is invalid: \(field)."
        case let .unsupportedSchema(version):
            "Workspace schema version is unsupported: \(version)."
        case .unsupportedLayout:
            "Workspace layout is unsupported."
        case let .invalidRelativePath(path):
            "Workspace path must be relative and contained: \(path)."
        case let .missingDirectory(path):
            "Workspace directory is missing: \(path)."
        case .migrationDestinationExists:
            "Migration destination already exists."
        }
    }
}

public final class WorkspaceManager {
    public static let manifestFileName = "manifest.json"

    private let fileManager: FileManager
    private let now: @Sendable () -> Date
    private let makeProjectID: @Sendable () -> String

    public init(
        fileManager: FileManager = .default,
        now: @escaping @Sendable () -> Date = Date.init,
        makeProjectID: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.fileManager = fileManager
        self.now = now
        self.makeProjectID = makeProjectID
    }

    public func createWorkspace(named displayName: String, in parentDirectory: URL) throws -> FilmWorkspace {
        try Self.validateDisplayName(displayName)
        let rootURL = parentDirectory
            .appendingPathComponent(displayName, isDirectory: true)
            .appendingPathExtension("filmproject")
            .standardizedFileURL

        guard !fileManager.fileExists(atPath: rootURL.path) else {
            throw WorkspaceError.workspaceAlreadyExists
        }

        try fileManager.createDirectory(at: parentDirectory, withIntermediateDirectories: true)
        do {
            try fileManager.createDirectory(at: rootURL, withIntermediateDirectories: false)
            for path in WorkspaceLayout.current.directoryPaths {
                try fileManager.createDirectory(
                    at: rootURL.appendingPathComponent(path, isDirectory: true),
                    withIntermediateDirectories: true
                )
            }

            let timestamp = now()
            let manifest = WorkspaceManifest(
                projectID: makeProjectID(),
                displayName: displayName,
                createdAt: timestamp,
                updatedAt: timestamp
            )
            try manifest.validate()
            try write(manifest, to: rootURL.appendingPathComponent(Self.manifestFileName))
            return try openWorkspace(at: rootURL)
        } catch {
            try? fileManager.removeItem(at: rootURL)
            throw error
        }
    }

    public func openWorkspace(at rootURL: URL) throws -> FilmWorkspace {
        let requestedRootURL = rootURL.standardizedFileURL
        guard requestedRootURL.pathExtension.lowercased() == "filmproject" else {
            throw WorkspaceError.invalidPackageExtension
        }
        let rootURL = Self.canonicalFileURL(requestedRootURL)
        guard rootURL.pathExtension.lowercased() == "filmproject" else {
            throw WorkspaceError.invalidPackageExtension
        }

        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: rootURL.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw WorkspaceError.workspaceNotFound
        }

        let manifestURL = try Self.containedURL(forRelativePath: Self.manifestFileName, in: rootURL)
        guard fileManager.fileExists(atPath: manifestURL.path) else {
            throw WorkspaceError.manifestNotFound
        }

        let manifest: WorkspaceManifest
        do {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            manifest = try decoder.decode(WorkspaceManifest.self, from: Data(contentsOf: manifestURL))
        } catch let error as WorkspaceError {
            throw error
        } catch {
            throw WorkspaceError.invalidManifest("json")
        }
        try manifest.validate()

        for path in manifest.layout.directoryPaths {
            let directoryURL = try Self.containedURL(forRelativePath: path, in: rootURL)
            var childIsDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: directoryURL.path, isDirectory: &childIsDirectory), childIsDirectory.boolValue else {
                throw WorkspaceError.missingDirectory(path)
            }
        }
        return FilmWorkspace(rootURL: rootURL, manifest: manifest)
    }

    public func copyWorkspace(_ workspace: FilmWorkspace, to parentDirectory: URL) throws -> FilmWorkspace {
        _ = try openWorkspace(at: workspace.rootURL)
        try fileManager.createDirectory(at: parentDirectory, withIntermediateDirectories: true)
        let destination = parentDirectory
            .appendingPathComponent(workspace.rootURL.lastPathComponent, isDirectory: true)
            .standardizedFileURL
        guard !fileManager.fileExists(atPath: destination.path) else {
            throw WorkspaceError.migrationDestinationExists
        }

        let staging = parentDirectory
            .appendingPathComponent(".filmos-copy-\(UUID().uuidString)", isDirectory: true)
            .appendingPathExtension("filmproject")
        defer { try? fileManager.removeItem(at: staging) }

        try fileManager.copyItem(at: workspace.rootURL, to: staging)
        _ = try openWorkspace(at: staging)
        guard !fileManager.fileExists(atPath: destination.path) else {
            throw WorkspaceError.migrationDestinationExists
        }
        try fileManager.moveItem(at: staging, to: destination)
        return try openWorkspace(at: destination)
    }

    fileprivate static func validateDisplayName(_ value: String) throws {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let invalidCharacters = CharacterSet(charactersIn: "/:").union(.controlCharacters)
        guard
            value == trimmed,
            (1...120).contains(value.count),
            value.rangeOfCharacter(from: invalidCharacters) == nil,
            value != ".",
            value != ".."
        else {
            throw WorkspaceError.invalidDisplayName
        }
    }

    fileprivate static func validateRelativePath(_ path: String) throws {
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard
            !path.isEmpty,
            !(path as NSString).isAbsolutePath,
            !path.contains("\\"),
            components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
            (path as NSString).standardizingPath == path
        else {
            throw WorkspaceError.invalidRelativePath(path)
        }
    }

    fileprivate static func containedURL(forRelativePath path: String, in rootURL: URL) throws -> URL {
        try validateRelativePath(path)
        let canonicalRoot = canonicalFileURL(rootURL)
        let canonicalCandidate = canonicalFileURL(
            canonicalRoot.appendingPathComponent(path, isDirectory: false)
        )
        let rootPath = canonicalRoot.path
        let candidatePath = canonicalCandidate.path
        guard candidatePath == rootPath || candidatePath.hasPrefix(rootPath.hasSuffix("/") ? rootPath : rootPath + "/") else {
            throw WorkspaceError.invalidRelativePath(path)
        }
        return canonicalCandidate
    }

    private static func canonicalFileURL(_ url: URL) -> URL {
        let standardized = url.standardizedFileURL
        var existingAncestor = standardized
        var missingComponents: [String] = []
        while existingAncestor.path != "/", !FileManager.default.fileExists(atPath: existingAncestor.path) {
            missingComponents.insert(existingAncestor.lastPathComponent, at: 0)
            existingAncestor.deleteLastPathComponent()
        }
        return missingComponents.reduce(existingAncestor.resolvingSymlinksInPath()) { partialURL, component in
            partialURL.appendingPathComponent(component)
        }.standardizedFileURL
    }

    private func write(_ manifest: WorkspaceManifest, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(manifest)
        try data.write(to: url, options: .atomic)
    }
}
