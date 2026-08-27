import AppKit
import FilmOSDesktopCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let content = NSViewController()
        let label = NSTextField(labelWithString: "FilmOS Studio")
        label.font = .systemFont(ofSize: 24, weight: .semibold)
        label.translatesAutoresizingMaskIntoConstraints = false

        let detail = NSTextField(labelWithString: "Desktop core is ready. Open/create UI and service wiring are pending.")
        detail.textColor = .secondaryLabelColor
        detail.translatesAutoresizingMaskIntoConstraints = false

        content.view.addSubview(label)
        content.view.addSubview(detail)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: content.view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: content.view.centerYAnchor, constant: -16),
            detail.centerXAnchor.constraint(equalTo: content.view.centerXAnchor),
            detail.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 10),
        ])

        let window = NSWindow(contentViewController: content)
        window.title = "FilmOS Studio"
        window.setContentSize(NSSize(width: 720, height: 440))
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
