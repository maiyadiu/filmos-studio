import AppKit
import FilmOSDesktopCore

@MainActor
final class ChatGPTConnectionWindow: NSObject {
    let window: NSWindow

    private let manager: ChatGPTConnectionManager
    private let projectID: () async -> String?
    private let tunnelIDField = NSTextField()
    private let runtimeKeyField = NSSecureTextField()
    private let stateLabel = NSTextField(labelWithString: "NOT_CONFIGURED")
    private let filmCoreValue = NSTextField(labelWithString: "未配置")
    private let mcpValue = NSTextField(labelWithString: "未配置")
    private let tunnelValue = NSTextField(labelWithString: "未配置")
    private let chatGPTValue = NSTextField(labelWithString: "未配置")
    private let grantValue = NSTextField(labelWithString: "未配置")
    private let billingValue = NSTextField(labelWithString: "ZERO")
    private let challengeValue = NSTextField(labelWithString: "未准备")
    private let connectButton = NSButton(title: "连接 ChatGPT", target: nil, action: nil)
    private let reconnectButton = NSButton(title: "重新连接", target: nil, action: nil)
    private let prepareButton = NSButton(title: "准备 ChatGPT Live Gate", target: nil, action: nil)

    init(manager: ChatGPTConnectionManager, projectID: @escaping () async -> String?) {
        self.manager = manager
        self.projectID = projectID
        let content = NSView()
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 660),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "ChatGPT 连接"
        window.contentView = content
        DesktopWindowLifecycle.configureReusable(window)
        super.init()

        let title = NSTextField(labelWithString: "ChatGPT 连接")
        title.font = .systemFont(ofSize: 24, weight: .semibold)
        let subtitle = NSTextField(labelWithString: "FilmOS 管理 Film Core、只读 MCP 与 OpenAI Secure Tunnel。Runtime Key 只保存在 macOS Keychain。")
        subtitle.textColor = .secondaryLabelColor
        subtitle.maximumNumberOfLines = 0
        subtitle.lineBreakMode = .byWordWrapping

        stateLabel.font = .monospacedSystemFont(ofSize: 11, weight: .semibold)
        stateLabel.textColor = .secondaryLabelColor

        let statusGrid = NSGridView(views: [
            statusRow("●", "Film Core", filmCoreValue),
            statusRow("●", "FilmOS MCP", mcpValue),
            statusRow("●", "Secure Tunnel", tunnelValue),
            statusRow("○", "ChatGPT", chatGPTValue),
            statusRow("●", "Project Grant", grantValue),
            statusRow("●", "Model API Billing", billingValue),
        ])
        statusGrid.rowSpacing = 10
        statusGrid.columnSpacing = 12
        statusGrid.column(at: 0).xPlacement = .trailing
        statusGrid.column(at: 2).xPlacement = .trailing

        tunnelIDField.placeholderString = "tunnel_..."
        runtimeKeyField.placeholderString = "Runtime Key（写入 Keychain 后清空）"
        if let saved = manager.savedConfiguration { tunnelIDField.stringValue = saved.tunnelID }

        for button in [connectButton, reconnectButton, prepareButton] {
            button.bezelStyle = .rounded
            button.target = self
        }
        connectButton.action = #selector(connect)
        reconnectButton.action = #selector(reconnect)
        prepareButton.action = #selector(prepareLiveGate)

        let disconnectButton = NSButton(title: "断开", target: self, action: #selector(disconnect))
        let doctorButton = NSButton(title: "诊断", target: self, action: #selector(diagnose))
        let tunnelSettingsButton = NSButton(title: "打开 Tunnel 设置", target: self, action: #selector(openTunnelSettings))
        let chatGPTSettingsButton = NSButton(title: "打开 ChatGPT 设置", target: self, action: #selector(openChatGPTSettings))
        let primaryButtons = NSStackView(views: [connectButton, reconnectButton, disconnectButton, doctorButton])
        primaryButtons.orientation = .horizontal
        primaryButtons.spacing = 8
        let settingsButtons = NSStackView(views: [tunnelSettingsButton, chatGPTSettingsButton])
        settingsButtons.orientation = .horizontal
        settingsButtons.spacing = 8

        challengeValue.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        challengeValue.textColor = .secondaryLabelColor
        challengeValue.lineBreakMode = .byTruncatingMiddle

        let stack = NSStackView(views: [
            title,
            subtitle,
            stateLabel,
            separator(),
            statusGrid,
            separator(),
            formLabel("Tunnel ID"),
            tunnelIDField,
            formLabel("Runtime Key"),
            runtimeKeyField,
            primaryButtons,
            settingsButtons,
            separator(),
            formLabel("External Live Gate Challenge"),
            challengeValue,
            prepareButton,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 28),
            tunnelIDField.widthAnchor.constraint(equalTo: stack.widthAnchor),
            runtimeKeyField.widthAnchor.constraint(equalTo: stack.widthAnchor),
            statusGrid.widthAnchor.constraint(equalTo: stack.widthAnchor),
            prepareButton.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])

        render(manager.snapshot)
    }

    func show() {
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func connect() {
        let tunnelID = tunnelIDField.stringValue
        let runtimeKey = runtimeKeyField.stringValue
        setBusy(true)
        Task { [weak self] in
            guard let self else { return }
            defer { self.setBusy(false); self.runtimeKeyField.stringValue = "" }
            do {
                guard let projectID = await self.projectID(), !projectID.isEmpty else {
                    throw ChatGPTConnectionError.projectRequired
                }
                try await self.manager.connect(tunnelID: tunnelID, runtimeKey: runtimeKey, projectID: projectID)
            } catch { self.presentError(error) }
        }
    }

    @objc private func reconnect() {
        setBusy(true)
        Task { [weak self] in
            guard let self else { return }
            defer { self.setBusy(false) }
            do { try await self.manager.reconnect() }
            catch { self.presentError(error) }
        }
    }

    @objc private func disconnect() {
        manager.disconnect()
    }

    @objc private func diagnose() {
        Task { [weak self] in
            guard let self else { return }
            let report = await self.manager.diagnosticReport()
            let alert = NSAlert()
            alert.messageText = "FilmOS ChatGPT Connection Doctor"
            alert.informativeText = report
            alert.addButton(withTitle: "好")
            alert.beginSheetModal(for: self.window, completionHandler: nil)
        }
    }

    @objc private func prepareLiveGate() {
        setBusy(true)
        Task { [weak self] in
            guard let self else { return }
            defer { self.setBusy(false) }
            do {
                let prompt = try await self.manager.prepareLiveGate()
                let pasteboard = NSPasteboard.general
                pasteboard.clearContents()
                pasteboard.setString(prompt, forType: .string)
                let alert = NSAlert()
                alert.messageText = "Live Gate 已准备"
                alert.informativeText = "验收指令已复制到剪贴板。请在 ChatGPT 中连接 FilmOS Studio 后粘贴执行。"
                alert.addButton(withTitle: "好")
                alert.beginSheetModal(for: self.window, completionHandler: nil)
            } catch { self.presentError(error) }
        }
    }

    @objc private func openTunnelSettings() {
        NSWorkspace.shared.open(URL(string: "https://platform.openai.com/settings/organization/tunnels")!)
    }

    @objc private func openChatGPTSettings() {
        NSWorkspace.shared.open(URL(string: "https://chatgpt.com/#settings/Connectors")!)
    }

    func render(_ snapshot: ChatGPTConnectionSnapshot) {
        stateLabel.stringValue = snapshot.state.rawValue
        filmCoreValue.stringValue = label(snapshot.filmCoreStatus)
        mcpValue.stringValue = "\(label(snapshot.mcpStatus))  ·  \(snapshot.mcpReadToolCount) 读 / \(snapshot.mcpWriteToolCount) 写 / \(snapshot.mcpPaidToolCount) 付费 / \(snapshot.mcpDestructiveToolCount) 破坏"
        tunnelValue.stringValue = label(snapshot.tunnelStatus)
        chatGPTValue.stringValue = label(snapshot.chatgptReachabilityStatus)
        grantValue.stringValue = label(snapshot.grantStatus)
        billingValue.stringValue = snapshot.billingMode == "subscription_host_no_extra_model_api" ? "不使用额外模型 API" : label(snapshot.billingStatus)
        challengeValue.stringValue = snapshot.liveGateChallengeID ?? "未准备"
        reconnectButton.isHidden = snapshot.state != .tunnelFailed && snapshot.state != .tunnelReconnecting
    }

    private func setBusy(_ busy: Bool) {
        connectButton.isEnabled = !busy
        reconnectButton.isEnabled = !busy
        prepareButton.isEnabled = !busy
    }

    private func presentError(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = "ChatGPT 连接未完成"
        alert.informativeText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        alert.alertStyle = .warning
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window)
    }

    private func label(_ status: ConnectionCheckStatus) -> String {
        switch status {
        case .notConfigured: "未配置"
        case .starting: "启动中"
        case .pass: "正常"
        case .connected: "已连接"
        case .waiting: "等待连接"
        case .expired: "已过期"
        case .failed: "失败"
        case .zero: "ZERO"
        }
    }

    private func statusRow(_ dot: String, _ title: String, _ value: NSTextField) -> [NSView] {
        let marker = NSTextField(labelWithString: dot)
        marker.textColor = .systemGreen
        let name = NSTextField(labelWithString: title)
        name.font = .systemFont(ofSize: 13, weight: .medium)
        value.textColor = .secondaryLabelColor
        return [marker, name, value]
    }

    private func formLabel(_ value: String) -> NSTextField {
        let label = NSTextField(labelWithString: value)
        label.font = .systemFont(ofSize: 12, weight: .medium)
        return label
    }

    private func separator() -> NSBox {
        let box = NSBox()
        box.boxType = .separator
        return box
    }
}
