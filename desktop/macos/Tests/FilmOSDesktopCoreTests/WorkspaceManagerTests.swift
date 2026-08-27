import Foundation
import Testing

@testable import FilmOSDesktopCore

@Suite
struct WorkspaceManagerTests {
    @Test
    func createAndReopenPortableWorkspace() throws {
        let sandbox = makeSandbox()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let timestamp = Date(timeIntervalSince1970: 1_786_000_000)
        let manager = WorkspaceManager(
            now: { timestamp },
            makeProjectID: { "3f455d68-3bea-4a91-95af-445f4fd45bb8" }
        )

        let workspace = try manager.createWorkspace(named: "测试影片", in: sandbox)

        #expect(workspace.rootURL.lastPathComponent == "测试影片.filmproject")
        #expect(workspace.manifest.schemaVersion == 1)
        #expect(workspace.manifest.projectID == "3f455d68-3bea-4a91-95af-445f4fd45bb8")
        #expect(workspace.manifest.layout == .current)
        #expect(!FileManager.default.fileExists(atPath: workspace.rootURL.appendingPathComponent("film-core.sqlite").path))

        for path in WorkspaceLayout.current.directoryPaths {
            var isDirectory: ObjCBool = false
            #expect(
                FileManager.default.fileExists(
                    atPath: workspace.rootURL.appendingPathComponent(path).path,
                    isDirectory: &isDirectory
                )
            )
            #expect(isDirectory.boolValue, Comment(rawValue: path))
        }

        let manifestText = try String(contentsOf: workspace.manifestURL, encoding: .utf8)
        #expect(!manifestText.contains(sandbox.path))
        #expect(!manifestText.contains("/Users/"))
        #expect(!manifestText.localizedCaseInsensitiveContains("token"))
        #expect(!manifestText.localizedCaseInsensitiveContains("password"))

        let reopened = try manager.openWorkspace(at: workspace.rootURL)
        #expect(reopened == workspace)
    }

    @Test
    func rejectsNonFilmProjectPackage() throws {
        let sandbox = makeSandbox()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        try FileManager.default.createDirectory(at: sandbox, withIntermediateDirectories: true)

        do {
            _ = try WorkspaceManager().openWorkspace(at: sandbox)
            Issue.record("Expected invalid package extension")
        } catch {
            #expect(error as? WorkspaceError == .invalidPackageExtension)
        }
    }

    @Test
    func rejectsAbsoluteManifestPath() throws {
        let sandbox = makeSandbox()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let manager = WorkspaceManager()
        let workspace = try manager.createWorkspace(named: "Unsafe", in: sandbox)
        var document = try #require(
            JSONSerialization.jsonObject(with: Data(contentsOf: workspace.manifestURL)) as? [String: Any]
        )
        var layout = try #require(document["layout"] as? [String: Any])
        layout["mediaObjects"] = "/tmp/outside"
        document["layout"] = layout
        try JSONSerialization.data(withJSONObject: document, options: [.prettyPrinted, .sortedKeys])
            .write(to: workspace.manifestURL, options: .atomic)

        do {
            _ = try manager.openWorkspace(at: workspace.rootURL)
            Issue.record("Expected absolute manifest path rejection")
        } catch {
            #expect(error as? WorkspaceError == .invalidRelativePath("/tmp/outside"))
        }
    }

    @Test
    func rejectsManifestSymlinkThatEscapesWorkspace() throws {
        let sandbox = makeSandbox()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let manager = WorkspaceManager()
        let workspace = try manager.createWorkspace(named: "ManifestLink", in: sandbox)
        let outsideManifest = sandbox.appendingPathComponent("outside-manifest.json")
        try FileManager.default.moveItem(at: workspace.manifestURL, to: outsideManifest)
        guard try createSymbolicLinkOrSkip(at: workspace.manifestURL, pointingTo: outsideManifest) else { return }

        do {
            _ = try manager.openWorkspace(at: workspace.rootURL)
            Issue.record("Expected canonical manifest containment rejection")
        } catch {
            #expect(error as? WorkspaceError == .invalidRelativePath("manifest.json"))
        }
    }

    @Test
    func rejectsLayoutSymlinkForOpenAndWorkspaceFileLookup() throws {
        let sandbox = makeSandbox()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let manager = WorkspaceManager()
        let workspace = try manager.createWorkspace(named: "LayoutLink", in: sandbox)
        let receiptsURL = workspace.rootURL.appendingPathComponent("receipts", isDirectory: true)
        let outsideReceipts = sandbox.appendingPathComponent("outside-receipts", isDirectory: true)
        try FileManager.default.createDirectory(at: outsideReceipts, withIntermediateDirectories: true)
        try FileManager.default.removeItem(at: receiptsURL)
        guard try createSymbolicLinkOrSkip(at: receiptsURL, pointingTo: outsideReceipts) else { return }

        do {
            _ = try manager.openWorkspace(at: workspace.rootURL)
            Issue.record("Expected canonical layout containment rejection")
        } catch {
            #expect(error as? WorkspaceError == .invalidRelativePath("receipts"))
        }

        do {
            _ = try workspace.url(forRelativePath: "receipts/result.json")
            Issue.record("Expected canonical workspace file containment rejection")
        } catch {
            #expect(error as? WorkspaceError == .invalidRelativePath("receipts/result.json"))
        }
    }

    @Test
    func copiedWorkspaceReopensWithProjectData() throws {
        let sandbox = makeSandbox()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let sourceParent = sandbox.appendingPathComponent("source")
        let destinationParent = sandbox.appendingPathComponent("destination")
        let manager = WorkspaceManager()
        let source = try manager.createWorkspace(named: "Portable", in: sourceParent)
        let receipt = source.rootURL.appendingPathComponent("receipts/receipt.json")
        try Data("{\"ok\":true}".utf8).write(to: receipt)

        let copied = try manager.copyWorkspace(source, to: destinationParent)

        #expect(copied.manifest.projectID == source.manifest.projectID)
        #expect(try Data(contentsOf: copied.rootURL.appendingPathComponent("receipts/receipt.json")) == Data("{\"ok\":true}".utf8))
        _ = try manager.openWorkspace(at: copied.rootURL)
    }

    private func makeSandbox() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("FilmOSDesktopTests-\(UUID().uuidString)", isDirectory: true)
    }
}
