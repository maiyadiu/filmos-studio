import AppKit
import CryptoKit
import FilmOSDesktopCore
import UniformTypeIdentifiers
import WebKit

if ProcessInfo.processInfo.environment["FILMOS_DESKTOP_SMOKE_CHECK"] == "1" {
    print("{\"application\":\"FilmOS Studio\",\"services_started\":false,\"smoke_check\":true}")
    exit(EXIT_SUCCESS)
}

private let backendServiceID: ServiceID = "backend"
private let webServiceID: ServiceID = "web"
private let localRuntimeServiceID: ServiceID = "local-runtime"

@MainActor
private final class InternalWorkbenchCoordinator {
    let startURL: URL
    let dataDirectoryURL: URL
    let backupURL: URL

    private let configuration: InternalWorkbenchConfiguration
    private let supervisor: ServiceSupervisor
    let chatGPTConnectionManager: ChatGPTConnectionManager
    private let chatGPTRuntime: DesktopChatGPTRuntime
    private let localRuntimeHealthURL = URL(string: "http://127.0.0.1:17371/health")!
    private var startedServices: Set<ServiceID> = []

    init(bundle: Bundle = .main) throws {
        guard let resourceURL = bundle.url(forResource: "InternalRuntime", withExtension: "json") else {
            throw DesktopWorkbenchError.missingRuntimeConfiguration
        }
        let configuration = try InternalWorkbenchConfiguration.load(from: resourceURL)
        let fileManager = FileManager.default

        guard
            let bundleResources = bundle.resourceURL,
            let applicationSupportDirectory = fileManager.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first
        else {
            throw DesktopWorkbenchError.missingRuntimeDirectory
        }
        let helpersDirectory = bundle.bundleURL.appendingPathComponent("Contents/Helpers", isDirectory: true)
        let backendExecutable = helpersDirectory.appendingPathComponent("FilmOSBackend")
        let webExecutable = helpersDirectory.appendingPathComponent("FilmOSWeb")
        let localRuntimeExecutable = helpersDirectory.appendingPathComponent("FilmOSLocalRuntime")
        let canvasAgentMCPExecutable = helpersDirectory.appendingPathComponent("FilmOSCanvasAgentMCP")
        let webRoot = bundleResources.appendingPathComponent("Web", isDirectory: true)
        let webEntry = webRoot.appendingPathComponent("index.html")
        let applicationRuntimeRoot = applicationSupportDirectory.appendingPathComponent(
            configuration.applicationSupportDirectoryName,
            isDirectory: true
        )
        let backendDataDirectory = applicationRuntimeRoot.appendingPathComponent(
            configuration.backendDataDirectoryName,
            isDirectory: true
        )
        let workingDirectory = applicationRuntimeRoot.appendingPathComponent("Runtime", isDirectory: true)

        guard fileManager.isExecutableFile(atPath: backendExecutable.path) else {
            throw DesktopWorkbenchError.missingBundledBackend
        }
        guard fileManager.isExecutableFile(atPath: webExecutable.path) else {
            throw DesktopWorkbenchError.missingBundledWebServer
        }
        guard fileManager.isExecutableFile(atPath: localRuntimeExecutable.path) else {
            throw DesktopWorkbenchError.missingBundledLocalRuntime
        }
        guard fileManager.isExecutableFile(atPath: canvasAgentMCPExecutable.path) else {
            throw DesktopWorkbenchError.missingBundledCanvasAgentMCP
        }
        guard fileManager.fileExists(atPath: webEntry.path) else {
            throw DesktopWorkbenchError.missingBundledWebAssets
        }
        try fileManager.createDirectory(at: backendDataDirectory, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: workingDirectory, withIntermediateDirectories: true)

        let policy = try ServiceLaunchPolicy(
            allowedExecutableRoots: [helpersDirectory],
            allowedWorkingDirectoryRoots: [applicationRuntimeRoot]
        )
        let supervisor = ServiceSupervisor(policy: policy)
        guard
            let backendHost = configuration.backendHealthURL.host,
            let backendPort = configuration.backendHealthURL.port,
            let webHost = configuration.webHealthURL.host,
            let webPort = configuration.webHealthURL.port
        else {
            throw DesktopWorkbenchError.invalidRuntimeEndpoints
        }
        var backendEnvironment = Self.safeBaseEnvironment()
        backendEnvironment["CANVAS_BACKEND_ADDR"] = "\(backendHost):\(backendPort)"
        backendEnvironment["CANVAS_BACKEND_DATA_DIR"] = backendDataDirectory.path
        backendEnvironment["CANVAS_CORS_ORIGINS"] = Self.origin(for: configuration.webHealthURL)
        backendEnvironment["CANVAS_DESKTOP_LOCAL_AUTH_ENABLED"] = "true"
        backendEnvironment["PWD"] = workingDirectory.path
        try supervisor.register(
            ServiceDefinition(
                id: backendServiceID,
                displayName: "FilmOS Backend",
                executableURL: backendExecutable,
                workingDirectoryURL: workingDirectory,
                environment: backendEnvironment
            )
        )

        let localRuntimeDirectory = applicationRuntimeRoot.appendingPathComponent("LocalRuntime", isDirectory: true)
        try fileManager.createDirectory(at: localRuntimeDirectory, withIntermediateDirectories: true)
        var localRuntimeEnvironment = Self.safeBaseEnvironment()
        localRuntimeEnvironment["PORT"] = "17371"
        localRuntimeEnvironment["FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR"] = localRuntimeDirectory.path
        localRuntimeEnvironment["FRAMEFIELD_TRUSTED_WEB_ORIGINS"] = Self.origin(for: configuration.webHealthURL)
        localRuntimeEnvironment["FILMOS_AGENT_RUNTIME_PROFILE"] = configuration.agentRuntimeProfile
        localRuntimeEnvironment["FILMOS_AGENT_FEATURE_FLAGS_HASH"] = configuration.agentFeatureFlagsHash
        localRuntimeEnvironment["FILMOS_AGENT_GATEWAY_ENABLED"] = configuration.agentRuntimeProfile == "filmos-candidate" ? "true" : "false"
        localRuntimeEnvironment["FILMOS_CANVAS_AGENT_MCP_EXECUTABLE"] = canvasAgentMCPExecutable.path
        for (flagID, value) in configuration.agentFeatureFlags {
            localRuntimeEnvironment[Self.agentRuntimeEnvironmentName(flagID)] = value ? "true" : "false"
        }
        localRuntimeEnvironment["PWD"] = localRuntimeDirectory.path
        try supervisor.register(ServiceDefinition(
            id: localRuntimeServiceID,
            displayName: "FilmOS Local Runtime",
            executableURL: localRuntimeExecutable,
            workingDirectoryURL: localRuntimeDirectory,
            environment: localRuntimeEnvironment
        ))

        var webEnvironment = Self.safeBaseEnvironment()
        webEnvironment["FILMOS_WEB_ADDR"] = "\(webHost):\(webPort)"
        webEnvironment["FILMOS_WEB_ROOT"] = webRoot.path
        webEnvironment["FILMOS_BACKEND_ORIGIN"] = Self.origin(for: configuration.backendHealthURL)
        webEnvironment["PWD"] = workingDirectory.path
        try supervisor.register(
            ServiceDefinition(
                id: webServiceID,
                displayName: "FilmOS Web Workbench",
                executableURL: webExecutable,
                workingDirectoryURL: workingDirectory,
                environment: webEnvironment
            )
        )

        let chatGPTRuntime = try DesktopChatGPTRuntime(
            supervisor: supervisor,
            helpersDirectory: helpersDirectory,
            applicationRuntimeRoot: applicationRuntimeRoot,
            baseEnvironment: Self.safeBaseEnvironment()
        )
        self.configuration = configuration
        self.supervisor = supervisor
        self.chatGPTRuntime = chatGPTRuntime
        chatGPTConnectionManager = ChatGPTConnectionManager(operations: chatGPTRuntime)
        startURL = configuration.startURL
        dataDirectoryURL = backendDataDirectory
        backupURL = try Self.backupURL(
            from: configuration.backendHealthURL,
            applicationVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        )
    }

    func prepare() async throws -> URL {
        try await ensureService(
            localRuntimeServiceID,
            displayName: "Agent Runtime",
            readiness: { [configuration, localRuntimeHealthURL] in
                await Self.localRuntimeIsReady(at: localRuntimeHealthURL, configuration: configuration)
            }
        )
        try await ensureService(
            backendServiceID,
            displayName: "本地后端",
            readiness: { [configuration] in
                await Self.backendIsReady(at: configuration.backendHealthURL)
            }
        )
        try await ensureService(
            webServiceID,
            displayName: "Web 工作台",
            readiness: { [configuration] in
                await Self.webIsReady(at: configuration.webHealthURL)
            }
        )
        return startURL
    }

    func stopOwnedServices() {
        chatGPTConnectionManager.disconnect()
        chatGPTRuntime.stopOwnedServices()
        for id in [webServiceID, backendServiceID, localRuntimeServiceID] where startedServices.contains(id) {
            guard case .running = supervisor.state(for: id) else { continue }
            try? supervisor.stop(id)
        }
        startedServices.removeAll()
    }

    private func ensureService(
        _ id: ServiceID,
        displayName: String,
        readiness: @escaping () async -> Bool
    ) async throws {
        if await readiness() { return }

        if !startedServices.contains(id) {
            do {
                try supervisor.start(id)
                startedServices.insert(id)
            } catch {
                if await readiness() { return }
                throw DesktopWorkbenchError.serviceLaunchFailed(displayName)
            }
        }

        for _ in 0..<120 {
            try Task.checkCancellation()
            if await readiness() { return }
            if case .stopped = supervisor.state(for: id) {
                break
            }
            try await Task.sleep(for: .milliseconds(250))
        }
        throw DesktopWorkbenchError.serviceUnavailable(displayName)
    }

    private static func safeBaseEnvironment() -> [String: String] {
        let inherited = ProcessInfo.processInfo.environment
        var environment = [
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": inherited["LANG"] ?? "zh_CN.UTF-8",
        ]
        for key in ["HOME", "TMPDIR", "USER", "SHELL"] {
            if let value = inherited[key], !value.isEmpty {
                environment[key] = value
            }
        }
        return environment
    }

    private static func origin(for url: URL) -> String {
        var components = URLComponents()
        components.scheme = url.scheme
        components.host = url.host
        components.port = url.port
        return components.string ?? ""
    }

    private static func agentRuntimeEnvironmentName(_ flagID: String) -> String {
        switch flagID {
        case "film.agent_native_brain_selector": "FILMOS_AGENT_NATIVE_BRAIN_SELECTOR"
        case "film.agent_generic_runtime": "FILMOS_AGENT_GENERIC_RUNTIME"
        case "film.agent_context_broker": "FILMOS_AGENT_CONTEXT_BROKER"
        case "film.agent_canonical_tool_manifest": "FILMOS_AGENT_CANONICAL_TOOL_MANIFEST"
        case "film.agent_canonical_tool_broker": "FILMOS_AGENT_CANONICAL_TOOL_BROKER"
        case "film.agent_codex_subscription": "FILMOS_AGENT_CODEX_SUBSCRIPTION"
        case "film.agent_chatgpt_host": "FILMOS_AGENT_CHATGPT_HOST"
        case "film.agent_model_api_profiles": "FILMOS_AGENT_MODEL_API_PROFILES"
        case "film.agent_no_silent_api_fallback": "FILMOS_AGENT_NO_SILENT_API_FALLBACK"
        case "film.agent_request_scoped_identity": "FILMOS_AGENT_REQUEST_SCOPED_IDENTITY"
        default: preconditionFailure("Unknown Agent feature flag")
        }
    }

    private static func backupURL(from healthURL: URL, applicationVersion: String?) throws -> URL {
        guard var components = URLComponents(url: healthURL, resolvingAgainstBaseURL: false) else {
            throw DesktopWorkbenchError.invalidRuntimeEndpoints
        }
        components.path = "/api/desktop/backup"
        components.queryItems = [
            URLQueryItem(name: "app_version", value: applicationVersion?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
        ]
        guard let url = components.url else {
            throw DesktopWorkbenchError.invalidRuntimeEndpoints
        }
        return url
    }

    private static func backendIsReady(at url: URL) async -> Bool {
        guard
            let data = await responseData(at: url),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            object["code"] as? Int == 0,
            let payload = object["data"] as? [String: Any],
            payload["status"] as? String == "ok"
        else {
            return false
        }
        return true
    }

    private static func webIsReady(at url: URL) async -> Bool {
        guard
            let data = await responseData(at: url),
            let html = String(data: data, encoding: .utf8)
        else {
            return false
        }
        return html.contains("name=\"filmos-workbench\"")
            && html.contains("content=\"v1\"")
    }

    private static func localRuntimeIsReady(at url: URL, configuration: InternalWorkbenchConfiguration) async -> Bool {
        guard
            let data = await responseData(at: url),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            object["ok"] as? Bool == true,
            object["agent_runtime_profile"] as? String == configuration.agentRuntimeProfile,
            object["agent_feature_flags_hash"] as? String == configuration.agentFeatureFlagsHash,
            object["agent_feature_flag_count"] as? Int == InternalWorkbenchConfiguration.agentFeatureFlagIDs.count,
            object["agent_activation_consistent"] as? Bool == true,
            object["agent_generic_runtime_enabled"] as? Bool == (configuration.agentRuntimeProfile == "filmos-candidate")
        else {
            return false
        }
        return true
    }

    private static func responseData(at url: URL) async -> Data? {
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 2
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
                return nil
            }
            return data
        } catch {
            return nil
        }
    }
}

private enum DesktopWorkbenchError: Error, LocalizedError {
    case missingRuntimeConfiguration
    case missingRuntimeDirectory
    case missingBundledBackend
    case missingBundledWebServer
    case missingBundledLocalRuntime
    case missingBundledCanvasAgentMCP
    case missingBundledWebAssets
    case invalidRuntimeEndpoints
    case serviceLaunchFailed(String)
    case serviceUnavailable(String)

    var errorDescription: String? {
        switch self {
        case .missingRuntimeConfiguration:
            "应用缺少内部工作台配置，请重新构建 FilmOS Studio.app。"
        case .missingRuntimeDirectory:
            "无法定位 FilmOS Studio 的应用支持目录。"
        case .missingBundledBackend:
            "应用缺少本地后端，请重新构建 FilmOS Studio.app。"
        case .missingBundledWebServer:
            "应用缺少内置 Web 服务，请重新构建 FilmOS Studio.app。"
        case .missingBundledLocalRuntime:
            "应用缺少 Agent Runtime，请重新构建 FilmOS Studio.app。"
        case .missingBundledCanvasAgentMCP:
            "应用缺少 Canvas Agent MCP，请重新构建 FilmOS Studio.app。"
        case .missingBundledWebAssets:
            "应用缺少内置工作台页面，请重新构建 FilmOS Studio.app。"
        case .invalidRuntimeEndpoints:
            "内部工作台端口配置无效，请重新构建 FilmOS Studio.app。"
        case let .serviceLaunchFailed(name):
            "\(name)无法启动；应用不会占用或结束其他程序的端口。"
        case let .serviceUnavailable(name):
            "\(name)未在预期时间内就绪，请检查 FilmOS 专用端口与项目日志。"
        }
    }
}

@MainActor
private final class WorkbenchWindow: NSObject, @preconcurrency WKNavigationDelegate, @preconcurrency WKUIDelegate, @preconcurrency WKScriptMessageHandler {
    let window: NSWindow
    var onOpenChatGPTConnection: (() -> Void)?
    var onWorkbenchProjectChanged: ((String, String?, String?) -> Void)?
    var onChatGPTHostRequest: ((String, String, Data) -> Void)?

    private let webView: WKWebView
    private let overlay = NSVisualEffectView()
    private let progress = NSProgressIndicator()
    private let statusLabel = NSTextField(labelWithString: "正在启动 FilmOS Studio…")
    private let retryButton = NSButton(title: "重试", target: nil, action: nil)
    private var retryHandler: (() -> Void)?

    override init() {
        let webConfiguration = WKWebViewConfiguration()
        webConfiguration.websiteDataStore = .default()
        webConfiguration.preferences.isElementFullscreenEnabled = true
        webView = WKWebView(frame: .zero, configuration: webConfiguration)

        let content = NSView()
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.contentView = content
        window.title = "FilmOS Studio"
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 960, height: 640)
        window.setFrameAutosaveName("FilmOSStudioWorkbench")

        super.init()

        webConfiguration.userContentController.add(self, name: "filmosDesktop")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(webView)

        overlay.material = .underWindowBackground
        overlay.blendingMode = .withinWindow
        overlay.state = .active
        overlay.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(overlay)

        progress.style = .spinning
        progress.controlSize = .regular
        progress.translatesAutoresizingMaskIntoConstraints = false
        progress.startAnimation(nil)
        overlay.addSubview(progress)

        statusLabel.font = .systemFont(ofSize: 15, weight: .medium)
        statusLabel.alignment = .center
        statusLabel.maximumNumberOfLines = 0
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(statusLabel)

        retryButton.bezelStyle = .rounded
        retryButton.target = self
        retryButton.action = #selector(retry)
        retryButton.isHidden = true
        retryButton.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(retryButton)

        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            overlay.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: content.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            progress.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            progress.centerYAnchor.constraint(equalTo: overlay.centerYAnchor, constant: -28),
            statusLabel.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            statusLabel.topAnchor.constraint(equalTo: progress.bottomAnchor, constant: 18),
            statusLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 560),
            retryButton.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            retryButton.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 18),
        ])
    }

    func show() {
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    func showLoading(_ message: String) {
        retryHandler = nil
        statusLabel.stringValue = message
        retryButton.isHidden = true
        progress.isHidden = false
        progress.startAnimation(nil)
        overlay.isHidden = false
    }

    func showError(_ message: String, retry: @escaping () -> Void) {
        retryHandler = retry
        statusLabel.stringValue = message
        retryButton.isHidden = false
        progress.stopAnimation(nil)
        progress.isHidden = true
        overlay.isHidden = false
    }

    func load(_ url: URL) {
        showLoading("正在打开创作工作台…")
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    func reload() {
        webView.reload()
    }

    func currentDomainProjectID() async -> String? {
        guard let value = try? await webView.callAsyncJavaScript(
            "return window.filmOSGetWorkbenchContext?.() ?? null;",
            arguments: [:],
            in: nil,
            contentWorld: .page
        ), let context = value as? [String: Any], let projectID = context["domainProjectId"] as? String else {
            return nil
        }
        let normalized = projectID.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? nil : normalized
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "filmosDesktop", message.frameInfo.isMainFrame,
              ["127.0.0.1", "localhost"].contains(message.frameInfo.securityOrigin.host),
              let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        if action == "openChatGPTConnection", body.count == 1 {
            onOpenChatGPTConnection?()
            return
        }
        if action == "workbenchContextChanged",
           Set(body.keys).isSubset(of: ["action", "projectId", "canvasId", "contextReceiptId"]),
           let projectID = body["projectId"] as? String {
            let normalized = projectID.trimmingCharacters(in: .whitespacesAndNewlines)
            guard normalized.isEmpty || normalized.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", options: .regularExpression) != nil else { return }
            let canvasID = (body["canvasId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let receiptID = (body["contextReceiptId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            onWorkbenchProjectChanged?(normalized, canvasID?.isEmpty == false ? canvasID : nil, receiptID?.isEmpty == false ? receiptID : nil)
            return
        }
        if action == "chatgptHostRequest",
           Set(body.keys) == Set(["action", "requestId", "operation", "payload"]),
           let requestID = body["requestId"] as? String,
           requestID.range(of: "^[A-Fa-f0-9-]{36}$", options: .regularExpression) != nil,
           let operation = body["operation"] as? String,
           ["publish_context", "publish_handoff"].contains(operation),
           let payload = body["payload"] as? [String: Any],
           JSONSerialization.isValidJSONObject(payload),
           let data = try? JSONSerialization.data(withJSONObject: payload), data.count <= 256 * 1024 {
            onChatGPTHostRequest?(requestID, operation, data)
        }
    }

    func publishChatGPTHostStatus(_ snapshot: ChatGPTConnectionSnapshot) {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var payload: [String: Any] = [
            "profileId": snapshot.profileID,
            "state": snapshot.state.rawValue,
            "tunnelConnected": snapshot.tunnelStatus == .connected,
            "externalAccountConnected": snapshot.chatgptReachabilityStatus == .connected,
            "mcpToolCount": snapshot.mcpToolCount,
            "mcpReadToolCount": snapshot.mcpReadToolCount,
            "mcpWriteToolCount": snapshot.mcpWriteToolCount,
            "mcpPaidToolCount": snapshot.mcpPaidToolCount,
            "mcpDestructiveToolCount": snapshot.mcpDestructiveToolCount,
            "billingMode": snapshot.billingMode,
            "proposalHandoffEnabled": snapshot.proposalHandoffEnabled,
        ]
        if let projectID = snapshot.authorizedProjectID { payload["authorizedProjectId"] = projectID }
        if let grantID = snapshot.grantID { payload["authorizedGrantId"] = grantID }
        if let expiresAt = snapshot.grantExpiresAt { payload["grantExpiresAt"] = formatter.string(from: expiresAt) }
        if let readAt = snapshot.lastExternalRequest?.timestamp { payload["lastReadAt"] = formatter.string(from: readAt) }
        if let toolName = snapshot.lastExternalRequest?.toolName { payload["lastExternalToolName"] = toolName }
        if let requestID = snapshot.lastExternalRequest?.requestID { payload["lastExternalRequestId"] = requestID }
        if let handoffID = snapshot.lastExternalRequest?.handoffID { payload["observedHandoffId"] = handoffID }
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.filmOSChatGPTHostStatus=\(json);window.dispatchEvent(new CustomEvent('filmos:chatgpt-host-status',{detail:window.filmOSChatGPTHostStatus}));")
    }

    func resolveChatGPTHostRequest(requestID: String, data: Data?, error: String?) {
        let result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) }
        Task {
            _ = try? await webView.callAsyncJavaScript(
                "window.filmOSResolveChatGPTHostRequest?.(requestId, result, error);",
                arguments: ["requestId": requestID, "result": result ?? NSNull(), "error": error ?? NSNull()],
                in: nil,
                contentWorld: .page
            )
        }
    }

    func flushForBackup() async throws {
        _ = try await webView.callAsyncJavaScript(
            """
            if (typeof window.filmOSFlushForBackup !== "function") {
                throw new Error("FilmOS 备份桥尚未就绪");
            }
            return await window.filmOSFlushForBackup();
            """,
            arguments: [:],
            in: nil,
            contentWorld: .page
        )
    }

    @objc private func retry() {
        retryHandler?()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        overlay.isHidden = true
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showNavigationError()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showNavigationError()
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    private func showNavigationError() {
        showError("工作台页面暂时无法载入。现有服务不会被结束，你可以直接重试。") { [weak self] in
            self?.webView.reload()
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var workbenchWindow: WorkbenchWindow?
    private var coordinator: InternalWorkbenchCoordinator?
    private var launchTask: Task<Void, Never>?
    private var proposalWindow: NSWindow?
    private var proposalRuntime: Result<ProposalOpenRuntime, Error>?
    private var chatGPTConnectionWindow: ChatGPTConnectionWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        let workbenchWindow = WorkbenchWindow()
        workbenchWindow.onOpenChatGPTConnection = { [weak self] in self?.openChatGPTConnection() }
        workbenchWindow.onWorkbenchProjectChanged = { [weak self] projectID, canvasID, receiptID in
            guard let manager = self?.coordinator?.chatGPTConnectionManager else { return }
            Task {
                if projectID.isEmpty { await manager.deactivateProject() }
                else { try? await manager.activateProject(projectID: projectID, canvasID: canvasID, contextReceiptID: receiptID) }
            }
        }
        workbenchWindow.onChatGPTHostRequest = { [weak self, weak workbenchWindow] requestID, operation, payload in
            guard let manager = self?.coordinator?.chatGPTConnectionManager else {
                workbenchWindow?.resolveChatGPTHostRequest(requestID: requestID, data: nil, error: "CHATGPT_CONNECTION_MANAGER_UNAVAILABLE")
                return
            }
            Task {
                do {
                    let result = operation == "publish_context"
                        ? try await manager.publishHostContext(payload)
                        : try await manager.publishPendingHostHandoff(payload)
                    workbenchWindow?.resolveChatGPTHostRequest(requestID: requestID, data: result, error: nil)
                } catch {
                    workbenchWindow?.resolveChatGPTHostRequest(requestID: requestID, data: nil, error: "CHATGPT_HOST_REQUEST_REJECTED")
                }
            }
        }
        self.workbenchWindow = workbenchWindow
        workbenchWindow.show()
        startWorkbench()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            workbenchWindow?.show()
        }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        launchTask?.cancel()
        coordinator?.stopOwnedServices()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let proposalURL = urls.first(where: { $0.pathExtension.lowercased() == "filmosproposal" }) else {
            return
        }
        openProposalPreview(proposalURL)
    }

    @objc private func reloadWorkbench() {
        workbenchWindow?.reload()
    }

    @objc private func openChatGPTConnection() {
        guard let coordinator else {
            presentAlert(title: "工作台尚未就绪", message: "请等待 FilmOS Studio 启动完成。", style: .warning)
            return
        }
        if chatGPTConnectionWindow == nil {
            chatGPTConnectionWindow = ChatGPTConnectionWindow(
                manager: coordinator.chatGPTConnectionManager,
                projectID: { [weak self] in
                    await self?.workbenchWindow?.currentDomainProjectID()
                }
            )
        }
        chatGPTConnectionWindow?.show()
    }

    @objc private func openFilmOSDataDirectory() {
        do {
            let directory: URL
            if let coordinator {
                directory = coordinator.dataDirectoryURL
            } else {
                let layout = try LocalDataLayout.resolve()
                try layout.prepareDirectories()
                directory = layout.workbenchDataURL
            }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            NSWorkspace.shared.open(directory)
        } catch {
            presentAlert(title: "无法打开 FilmOS 数据目录", message: error.localizedDescription, style: .warning)
        }
    }

    @objc private func exportFilmOSBackup() {
        guard let coordinator, let workbenchWindow else {
            presentAlert(title: "工作台尚未就绪", message: "请等待 FilmOS Studio 启动完成后再导出备份。", style: .warning)
            return
        }

        let panel = NSSavePanel()
        panel.title = "导出 FilmOS 备份包"
        panel.prompt = "导出备份"
        panel.nameFieldStringValue = Self.backupFilename()
        panel.allowedContentTypes = [UTType(exportedAs: "com.filmos.backup", conformingTo: .zip)]
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let destinationURL = panel.url else {
            return
        }

        Task { [weak self] in
            guard let self else { return }
            do {
                try await workbenchWindow.flushForBackup()
                var request = URLRequest(url: coordinator.backupURL)
                request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
                request.timeoutInterval = 300
                let (temporaryURL, response) = try await URLSession.shared.download(for: request)
                guard
                    let response = response as? HTTPURLResponse,
                    response.statusCode == 200,
                    response.value(forHTTPHeaderField: "X-FilmOS-Backup-Format") == "filmos.local-backup/v1",
                    let expectedHash = response.value(forHTTPHeaderField: "X-FilmOS-Backup-SHA256")?.lowercased(),
                    expectedHash.count == 64
                else {
                    throw DesktopBackupExportError.invalidResponse
                }
                let actualHash = try Self.sha256(of: temporaryURL)
                guard actualHash == expectedHash else {
                    throw DesktopBackupExportError.hashMismatch
                }
                try Self.installDownloadedBackup(from: temporaryURL, at: destinationURL)
                self.presentAlert(
                    title: "FilmOS 备份已导出",
                    message: "备份包已校验并保存。\n\n恢复后需重新录入 Provider 密钥和 CLI 登录凭据。",
                    style: .informational
                )
            } catch {
                self.presentAlert(title: "FilmOS 备份导出失败", message: error.localizedDescription, style: .warning)
            }
        }
    }

    private func startWorkbench() {
        launchTask?.cancel()
        workbenchWindow?.showLoading("正在检查本地工作台服务…")
        launchTask = Task { [weak self] in
            guard let self else { return }
            do {
                let coordinator: InternalWorkbenchCoordinator
                if let existing = self.coordinator {
                    coordinator = existing
                } else {
                    coordinator = try InternalWorkbenchCoordinator()
                    self.coordinator = coordinator
                    coordinator.chatGPTConnectionManager.onSnapshot = { [weak self] snapshot in
                        self?.workbenchWindow?.publishChatGPTHostStatus(snapshot)
                        self?.chatGPTConnectionWindow?.render(snapshot)
                    }
                }
                let url = try await coordinator.prepare()
                try Task.checkCancellation()
                self.workbenchWindow?.load(url)
                await coordinator.chatGPTConnectionManager.autoConnectIfConfigured()
            } catch is CancellationError {
                return
            } catch {
                let message = (error as? LocalizedError)?.errorDescription ?? "内部工作台无法启动。"
                self.workbenchWindow?.showError(message) { [weak self] in
                    self?.startWorkbench()
                }
            }
        }
    }

    private func installMainMenu() {
        let mainMenu = NSMenu()
        let applicationItem = NSMenuItem()
        mainMenu.addItem(applicationItem)
        let applicationMenu = NSMenu()
        applicationMenu.addItem(
            withTitle: "关于 FilmOS Studio",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(
            withTitle: "退出 FilmOS Studio",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        applicationItem.submenu = applicationMenu

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "显示")
        let reloadItem = NSMenuItem(title: "重新载入工作台", action: #selector(reloadWorkbench), keyEquivalent: "r")
        reloadItem.target = self
        viewMenu.addItem(reloadItem)
        viewMenu.addItem(.separator())
        let dataDirectoryItem = NSMenuItem(title: "打开 FilmOS 数据目录", action: #selector(openFilmOSDataDirectory), keyEquivalent: "")
        dataDirectoryItem.target = self
        viewMenu.addItem(dataDirectoryItem)
        let exportBackupItem = NSMenuItem(title: "导出 FilmOS 备份包…", action: #selector(exportFilmOSBackup), keyEquivalent: "")
        exportBackupItem.target = self
        viewMenu.addItem(exportBackupItem)
        viewItem.submenu = viewMenu

        let connectionItem = NSMenuItem()
        mainMenu.addItem(connectionItem)
        let connectionMenu = NSMenu(title: "连接")
        let chatGPTItem = NSMenuItem(title: "ChatGPT 连接…", action: #selector(openChatGPTConnection), keyEquivalent: "")
        chatGPTItem.target = self
        connectionMenu.addItem(chatGPTItem)
        connectionItem.submenu = connectionMenu
        NSApp.mainMenu = mainMenu
    }

    private static func backupFilename(now: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return "FilmOS备份-\(formatter.string(from: now)).filmosbackup"
    }

    private static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var digest = SHA256()
        while true {
            let data = try handle.read(upToCount: 1_048_576) ?? Data()
            if data.isEmpty { break }
            digest.update(data: data)
        }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func installDownloadedBackup(from temporaryURL: URL, at destinationURL: URL) throws {
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: destinationURL.path) {
            _ = try fileManager.replaceItemAt(destinationURL, withItemAt: temporaryURL)
        } else {
            try fileManager.moveItem(at: temporaryURL, to: destinationURL)
        }
    }

    private func presentAlert(title: String, message: String, style: NSAlert.Style) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = style
        alert.addButton(withTitle: "好")
        if let window = workbenchWindow?.window, window.isVisible {
            alert.beginSheetModal(for: window)
        } else {
            alert.runModal()
        }
    }

    private func openProposalPreview(_ proposalURL: URL) {
        let content = NSViewController()
        let detail = NSTextField(labelWithString: "正在请求 Film Core 预览…")
        detail.textColor = .secondaryLabelColor
        detail.translatesAutoresizingMaskIntoConstraints = false

        let preview = NSTextView()
        preview.isEditable = false
        preview.isSelectable = true
        preview.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        preview.string = "提案只会预览，不会在桌面应用内正式写入。"
        preview.textContainerInset = NSSize(width: 12, height: 12)
        let scroll = NSScrollView()
        scroll.documentView = preview
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false
        content.view.addSubview(detail)
        content.view.addSubview(scroll)
        NSLayoutConstraint.activate([
            detail.leadingAnchor.constraint(equalTo: content.view.leadingAnchor, constant: 24),
            detail.trailingAnchor.constraint(equalTo: content.view.trailingAnchor, constant: -24),
            detail.topAnchor.constraint(equalTo: content.view.topAnchor, constant: 24),
            scroll.leadingAnchor.constraint(equalTo: content.view.leadingAnchor, constant: 24),
            scroll.trailingAnchor.constraint(equalTo: content.view.trailingAnchor, constant: -24),
            scroll.topAnchor.constraint(equalTo: detail.bottomAnchor, constant: 16),
            scroll.bottomAnchor.constraint(equalTo: content.view.bottomAnchor, constant: -24),
        ])

        let window = NSWindow(contentViewController: content)
        window.title = "Film Core 提案预览"
        window.setContentSize(NSSize(width: 720, height: 440))
        window.center()
        window.makeKeyAndOrderFront(nil)
        proposalWindow = window

        let runtimeResult = proposalRuntime ?? Result { try ProposalOpenRuntime.fromEnvironment() }
        proposalRuntime = runtimeResult
        guard case let .success(runtime) = runtimeResult else {
            if case let .failure(error) = runtimeResult {
                detail.stringValue = error.localizedDescription
            }
            return
        }

        Task {
            let accessed = proposalURL.startAccessingSecurityScopedResource()
            defer {
                if accessed { proposalURL.stopAccessingSecurityScopedResource() }
            }
            do {
                let result = try await runtime.open(proposalURL)
                detail.stringValue = "\(result.status) — 未执行正式写入。"
                preview.string = Self.prettyJSON(result.displayJSON)
            } catch {
                detail.stringValue = Self.safeProposalError(error)
                preview.string = "提案预览被拒绝或暂不可用，未应用任何内容。"
            }
        }
    }

    private static func safeProposalError(_ error: Error) -> String {
        if case let ProposalHandoffError.importRejected(code, _) = error {
            return "Film Core 拒绝了提案（\(code)），未应用任何内容。"
        }
        if error is ProposalHandoffError || error is SecureTokenStoreError {
            return error.localizedDescription
        }
        return "提案预览暂不可用，未应用任何内容。"
    }

    private static func prettyJSON(_ data: Data) -> String {
        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let formatted = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
            let text = String(data: formatted, encoding: .utf8)
        else {
            return String(data: data, encoding: .utf8) ?? "已收到预览。"
        }
        return text
    }
}

private enum DesktopBackupExportError: Error, LocalizedError {
    case invalidResponse
    case hashMismatch

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "本地后端未返回有效的 FilmOS 备份包。"
        case .hashMismatch:
            "备份包下载后的 SHA-256 校验失败，未保存该文件。"
        }
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
