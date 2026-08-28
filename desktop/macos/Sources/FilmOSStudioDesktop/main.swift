import AppKit
import FilmOSDesktopCore

if ProcessInfo.processInfo.environment["FILMOS_DESKTOP_SMOKE_CHECK"] == "1" {
    print("{\"application\":\"FilmOS Studio\",\"services_started\":false,\"smoke_check\":true}")
    exit(EXIT_SUCCESS)
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var detailLabel: NSTextField?
    private var previewTextView: NSTextView?
    private var proposalRuntime: Result<ProposalOpenRuntime, Error>?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let content = NSViewController()
        let label = NSTextField(labelWithString: "FilmOS Studio")
        label.font = .systemFont(ofSize: 24, weight: .semibold)
        label.translatesAutoresizingMaskIntoConstraints = false

        let detail = NSTextField(labelWithString: "Desktop core is ready. Proposal handoff is disabled by default.")
        detail.textColor = .secondaryLabelColor
        detail.translatesAutoresizingMaskIntoConstraints = false

        let preview = NSTextView()
        preview.isEditable = false
        preview.isSelectable = true
        preview.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        preview.string = "Open a .filmosproposal file to request a Film Core preview. No proposal is applied here."
        preview.textContainerInset = NSSize(width: 12, height: 12)
        let previewScroll = NSScrollView()
        previewScroll.documentView = preview
        previewScroll.hasVerticalScroller = true
        previewScroll.borderType = .bezelBorder
        previewScroll.translatesAutoresizingMaskIntoConstraints = false

        content.view.addSubview(label)
        content.view.addSubview(detail)
        content.view.addSubview(previewScroll)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: content.view.centerXAnchor),
            label.topAnchor.constraint(equalTo: content.view.topAnchor, constant: 32),
            detail.centerXAnchor.constraint(equalTo: content.view.centerXAnchor),
            detail.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 10),
            previewScroll.leadingAnchor.constraint(equalTo: content.view.leadingAnchor, constant: 24),
            previewScroll.trailingAnchor.constraint(equalTo: content.view.trailingAnchor, constant: -24),
            previewScroll.topAnchor.constraint(equalTo: detail.bottomAnchor, constant: 20),
            previewScroll.bottomAnchor.constraint(equalTo: content.view.bottomAnchor, constant: -24),
        ])

        let window = NSWindow(contentViewController: content)
        window.title = "FilmOS Studio"
        window.setContentSize(NSSize(width: 720, height: 440))
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        detailLabel = detail
        previewTextView = preview
        proposalRuntime = Result { try ProposalOpenRuntime.fromEnvironment() }
        NSApp.activate(ignoringOtherApps: true)
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let proposalURL = urls.first(where: { $0.pathExtension.lowercased() == "filmosproposal" }) else {
            detailLabel?.stringValue = "FilmOS only routes .filmosproposal files through proposal preview."
            return
        }

        let runtimeResult = proposalRuntime ?? Result { try ProposalOpenRuntime.fromEnvironment() }
        proposalRuntime = runtimeResult
        guard case let .success(runtime) = runtimeResult else {
            if case let .failure(error) = runtimeResult {
                detailLabel?.stringValue = error.localizedDescription
            }
            return
        }

        detailLabel?.stringValue = "Requesting a preview from Film Core…"
        Task {
            let accessed = proposalURL.startAccessingSecurityScopedResource()
            defer {
                if accessed { proposalURL.stopAccessingSecurityScopedResource() }
            }
            do {
                let preview = try await runtime.open(proposalURL)
                detailLabel?.stringValue = "\(preview.status) — no formal write was executed."
                previewTextView?.string = Self.prettyJSON(preview.displayJSON)
            } catch {
                detailLabel?.stringValue = Self.safeErrorDescription(error)
                previewTextView?.string = "Proposal preview was rejected or unavailable. Nothing was applied."
            }
        }
    }

    private static func safeErrorDescription(_ error: Error) -> String {
        if case let ProposalHandoffError.importRejected(code, _) = error {
            return "Film Core rejected the proposal (\(code)). Nothing was applied."
        }
        if error is ProposalHandoffError || error is SecureTokenStoreError {
            return error.localizedDescription
        }
        return "Proposal preview is unavailable. Nothing was applied."
    }

    private static func prettyJSON(_ data: Data) -> String {
        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let formatted = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
            let text = String(data: formatted, encoding: .utf8)
        else {
            return String(data: data, encoding: .utf8) ?? "Preview received."
        }
        return text
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
