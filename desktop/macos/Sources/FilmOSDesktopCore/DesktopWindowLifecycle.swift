import AppKit

@MainActor
public enum DesktopWindowLifecycle {
    public static func configureReusable(_ window: NSWindow) {
        window.isReleasedWhenClosed = false
    }
}
