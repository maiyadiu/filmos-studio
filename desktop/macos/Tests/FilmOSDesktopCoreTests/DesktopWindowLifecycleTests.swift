import AppKit
import Testing

@testable import FilmOSDesktopCore

@MainActor
struct DesktopWindowLifecycleTests {
    @Test
    func reusableWindowIsNotReleasedWhenClosed() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 240),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )

        DesktopWindowLifecycle.configureReusable(window)

        #expect(window.isReleasedWhenClosed == false)
    }
}
