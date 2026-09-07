import AppKit
import Testing

@testable import FilmOSDesktopCore

@MainActor
struct DesktopEditMenuTests {
    @Test
    func standardShortcutsUseFocusedResponderWithoutCapturingClipboard() {
        let menu = DesktopEditMenu.make().submenu!
        let commands = menu.items.filter { !$0.isSeparatorItem }
        #expect(commands.map(\.keyEquivalent) == ["z", "z", "x", "c", "v", "a"])
        #expect(commands.map { NSStringFromSelector($0.action!) } == ["undo:", "redo:", "cut:", "copy:", "paste:", "selectAll:"])
        #expect(commands.allSatisfy { $0.target == nil })
        for (index, item) in commands.enumerated() {
            #expect(item.keyEquivalentModifierMask == (index == 1 ? [.command, .shift] : [.command]))
        }
    }
}
