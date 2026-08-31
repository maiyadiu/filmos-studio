import AppKit

public struct ExternalURLRequestQueue: Sendable {
    public private(set) var activeURL: URL?
    private var pendingURLs: [URL] = []

    public init() {}

    public mutating func enqueue(_ url: URL) -> URL? {
        guard Self.isWebURL(url), activeURL != url, !pendingURLs.contains(url) else {
            return nil
        }
        guard activeURL == nil else {
            pendingURLs.append(url)
            return nil
        }
        activeURL = url
        return url
    }

    public mutating func completeActiveRequest() -> URL? {
        activeURL = pendingURLs.isEmpty ? nil : pendingURLs.removeFirst()
        return activeURL
    }

    private static func isWebURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }
}

@MainActor
public final class ExternalURLRouter {
    public static let shared = ExternalURLRouter()

    private let workspace: NSWorkspace
    private var requests = ExternalURLRequestQueue()

    public init(workspace: NSWorkspace = .shared) {
        self.workspace = workspace
    }

    public func open(_ url: URL) {
        guard let nextURL = requests.enqueue(url) else { return }
        openSerially(nextURL)
    }

    private func openSerially(_ url: URL) {
        guard let applicationURL = workspace.urlForApplication(toOpen: url) else {
            _ = workspace.open(url)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.finishCurrentRequest()
            }
            return
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.createsNewApplicationInstance = false
        workspace.open(
            [url],
            withApplicationAt: applicationURL,
            configuration: configuration
        ) { [weak self] _, error in
            if let error {
                NSLog("FilmOS external URL open failed: %@", error.localizedDescription)
            }
            Task { @MainActor [weak self] in
                self?.finishCurrentRequest()
            }
        }
    }

    private func finishCurrentRequest() {
        guard let nextURL = requests.completeActiveRequest() else { return }
        openSerially(nextURL)
    }
}
