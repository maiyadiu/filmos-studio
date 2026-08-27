import Foundation
import Testing

@testable import FilmOSDesktopCore

@Suite
struct LocalDataLayoutTests {
    @Test
    func applicationSupportLayoutSeparatesHostStateFromPortableWorkspace() throws {
        let sandbox = FileManager.default.temporaryDirectory
            .appendingPathComponent("FilmOSLocalDataTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: sandbox) }

        let layout = try LocalDataLayout(applicationSupportRoot: sandbox)

        #expect(layout.rootURL.path == sandbox.appendingPathComponent("FilmOS Studio").path)
        #expect(layout.runtimeStateURL.lastPathComponent == "Runtime")
        #expect(layout.processLogsURL.lastPathComponent == "Logs")
        #expect(layout.migrationStagingURL.lastPathComponent == "MigrationStaging")
        #expect(layout.bookmarkStateURL.lastPathComponent == "Bookmarks")

        try layout.prepareDirectories()
        for directory in [layout.rootURL, layout.runtimeStateURL, layout.processLogsURL, layout.migrationStagingURL, layout.bookmarkStateURL] {
            var isDirectory: ObjCBool = false
            #expect(FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory))
            #expect(isDirectory.boolValue)
        }
    }

    @Test
    func rejectsFilesystemRoot() {
        do {
            _ = try LocalDataLayout(applicationSupportRoot: URL(fileURLWithPath: "/"))
            Issue.record("Expected filesystem root rejection")
        } catch {
            #expect(error as? LocalDataLayoutError == .invalidApplicationSupportRoot)
        }
    }
}
