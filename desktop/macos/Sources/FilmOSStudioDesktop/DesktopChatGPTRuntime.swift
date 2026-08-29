import CryptoKit
import FilmOSDesktopCore
import Foundation

private let filmCoreServiceID: ServiceID = "film-core"
private let chatGPTMCPServiceID: ServiceID = "chatgpt-mcp"
private let secureTunnelServiceID: ServiceID = "secure-tunnel"

@MainActor
final class DesktopChatGPTRuntime: ChatGPTConnectionOperating {
    private let supervisor: ServiceSupervisor
    private let tokenStore: any SecureTokenStoring
    private let tunnelClientURL: URL
    private let grantCLIURL: URL
    private let runtimeDirectory: URL
    private let mcpDirectory: URL
    private let grantStoreURL: URL
    private let authorizationHeaderURL: URL
    private let tunnelHealthURLFile: URL
    private var startedServices: Set<ServiceID> = []
    private var activeTransportProof: String?
    private var grantExpiresAt: Date?

    init(
        supervisor: ServiceSupervisor,
        helpersDirectory: URL,
        applicationRuntimeRoot: URL,
        baseEnvironment: [String: String],
        tokenStore: any SecureTokenStoring = KeychainTokenStore()
    ) throws {
        self.supervisor = supervisor
        self.tokenStore = tokenStore
        tunnelClientURL = helpersDirectory.appendingPathComponent("tunnel-client")
        grantCLIURL = helpersDirectory.appendingPathComponent("FilmOSChatGPTGrant")
        runtimeDirectory = applicationRuntimeRoot.appendingPathComponent("ChatGPTConnection", isDirectory: true)
        mcpDirectory = runtimeDirectory.appendingPathComponent("MCP", isDirectory: true)
        grantStoreURL = mcpDirectory.appendingPathComponent("grants.json")
        authorizationHeaderURL = runtimeDirectory.appendingPathComponent("mcp-authorization.header")
        tunnelHealthURLFile = runtimeDirectory.appendingPathComponent("tunnel-health.url")

        let fileManager = FileManager.default
        let coreDataDirectory = runtimeDirectory.appendingPathComponent("FilmCore", isDirectory: true)
        try fileManager.createDirectory(at: coreDataDirectory, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: mcpDirectory, withIntermediateDirectories: true)

        let filmCoreExecutable = helpersDirectory.appendingPathComponent("FilmOSFilmCore")
        let mcpExecutable = helpersDirectory.appendingPathComponent("FilmOSChatGPTMCP")
        for executable in [filmCoreExecutable, mcpExecutable, grantCLIURL, tunnelClientURL] {
            guard fileManager.isExecutableFile(atPath: executable.path) else {
                throw DesktopChatGPTRuntimeError.missingHelper(executable.lastPathComponent)
            }
        }

        var coreEnvironment = baseEnvironment
        coreEnvironment["FILMOS_CORE_DB_PATH"] = coreDataDirectory.appendingPathComponent("film-core.sqlite").path
        coreEnvironment["FILMOS_CORE_HOST"] = "127.0.0.1"
        coreEnvironment["FILMOS_CORE_PORT"] = "17650"
        coreEnvironment["PWD"] = runtimeDirectory.path
        try supervisor.register(ServiceDefinition(
            id: filmCoreServiceID,
            displayName: "Film Core",
            executableURL: filmCoreExecutable,
            workingDirectoryURL: runtimeDirectory,
            environment: coreEnvironment
        ))

        var mcpEnvironment = baseEnvironment
        mcpEnvironment["FILMOS_CHATGPT_APP_ENABLED"] = "true"
        mcpEnvironment["FILMOS_CHATGPT_READ_TOOLS_ENABLED"] = "true"
        mcpEnvironment["FILMOS_CHATGPT_WIDGETS_ENABLED"] = "true"
        mcpEnvironment["FILMOS_CHATGPT_PROPOSAL_HANDOFF_ENABLED"] = "false"
        mcpEnvironment["FILMOS_CHATGPT_HOST"] = "127.0.0.1"
        mcpEnvironment["FILMOS_CHATGPT_PORT"] = "17840"
        mcpEnvironment["FILMOS_CHATGPT_LOCAL_DIR"] = mcpDirectory.path
        mcpEnvironment["FILMOS_CORE_BASE_URL"] = "http://127.0.0.1:17650/film"
        mcpEnvironment["PWD"] = runtimeDirectory.path
        try supervisor.register(ServiceDefinition(
            id: chatGPTMCPServiceID,
            displayName: "FilmOS ChatGPT MCP",
            executableURL: mcpExecutable,
            workingDirectoryURL: runtimeDirectory,
            environment: mcpEnvironment
        ))

        var tunnelEnvironment = baseEnvironment
        tunnelEnvironment["PWD"] = runtimeDirectory.path
        try supervisor.register(ServiceDefinition(
            id: secureTunnelServiceID,
            displayName: "OpenAI Secure MCP Tunnel",
            executableURL: tunnelClientURL,
            arguments: Self.tunnelArguments(
                mode: "run",
                authorizationHeaderURL: authorizationHeaderURL,
                healthURLFile: tunnelHealthURLFile,
                runtimeDirectory: runtimeDirectory
            ),
            workingDirectoryURL: runtimeDirectory,
            environment: tunnelEnvironment
        ))
    }

    func prepareLocalServices(projectID: String, transportProof: String) async throws {
        try await ensureService(filmCoreServiceID) { await Self.endpointReady("http://127.0.0.1:17650/health") }
        let renewed = try await ensureGrant(projectID: projectID)
        let mcpReady = await Self.endpointReady("http://127.0.0.1:17840/health")
        if mcpReady, activeTransportProof == transportProof, !renewed { return }
        if startedServices.contains(chatGPTMCPServiceID), case .running = supervisor.state(for: chatGPTMCPServiceID) {
            try? supervisor.stop(chatGPTMCPServiceID)
            startedServices.remove(chatGPTMCPServiceID)
        } else if mcpReady {
            throw DesktopChatGPTRuntimeError.portOwnedByAnotherProcess(17840)
        }
        let runtime = try ServiceRuntimeEnvironment(
            values: ["FILMOS_SECURE_TUNNEL_PROOF": transportProof],
            secretKeys: ["FILMOS_SECURE_TUNNEL_PROOF"]
        )
        try await ensureService(chatGPTMCPServiceID, runtimeEnvironment: runtime) {
            await Self.endpointReady("http://127.0.0.1:17840/health")
        }
        activeTransportProof = transportProof
    }

    func runTunnelDoctor(
        tunnelID: String,
        runtimeKey: String,
        transportProof: String,
        challengeID: String
    ) async throws {
        let executable = tunnelClientURL
        let arguments = Self.tunnelArguments(
            mode: "doctor",
            authorizationHeaderURL: authorizationHeaderURL,
            healthURLFile: tunnelHealthURLFile,
            runtimeDirectory: runtimeDirectory
        )
        var environment = Self.safeBaseEnvironment()
        environment.merge(Self.tunnelRuntimeEnvironment(
            tunnelID: tunnelID,
            runtimeKey: runtimeKey,
            transportProof: transportProof,
            challengeID: challengeID
        )) { _, new in new }
        let workingDirectory = runtimeDirectory
        let succeeded = await Task.detached(priority: .userInitiated) {
            Self.runQuietProcess(
                executable: executable,
                arguments: arguments,
                environment: environment,
                workingDirectory: workingDirectory,
                timeout: 45
            )
        }.value
        guard succeeded else { throw DesktopChatGPTRuntimeError.tunnelDoctorFailed }
    }

    func startTunnel(
        tunnelID: String,
        runtimeKey: String,
        transportProof: String,
        challengeID: String
    ) throws {
        if case .running = supervisor.state(for: secureTunnelServiceID) { return }
        try? FileManager.default.removeItem(at: tunnelHealthURLFile)
        let values = Self.tunnelRuntimeEnvironment(
            tunnelID: tunnelID,
            runtimeKey: runtimeKey,
            transportProof: transportProof,
            challengeID: challengeID
        )
        let runtime = try ServiceRuntimeEnvironment(
            values: values,
            secretKeys: ["CONTROL_PLANE_API_KEY", "FILMOS_SECURE_TUNNEL_PROOF"]
        )
        try supervisor.start(secureTunnelServiceID, runtimeEnvironment: runtime)
        startedServices.insert(secureTunnelServiceID)
    }

    func stopTunnel() {
        guard startedServices.contains(secureTunnelServiceID), case .running = supervisor.state(for: secureTunnelServiceID) else {
            return
        }
        try? supervisor.stop(secureTunnelServiceID)
        startedServices.remove(secureTunnelServiceID)
        try? FileManager.default.removeItem(at: tunnelHealthURLFile)
    }

    func stopOwnedServices() {
        stopTunnel()
        for id in [chatGPTMCPServiceID, filmCoreServiceID] where startedServices.contains(id) {
            guard case .running = supervisor.state(for: id) else { continue }
            try? supervisor.stop(id)
        }
        startedServices.removeAll()
    }

    func runtimeHealth() async -> ChatGPTRuntimeHealth {
        let coreReady = await Self.endpointReady("http://127.0.0.1:17650/health")
        let payload = await Self.jsonPayload("http://127.0.0.1:17840/health")
        let tunnelReady = await tunnelIsReady()
        let external = Self.externalRequest(from: payload)
        return ChatGPTRuntimeHealth(
            filmCoreReady: coreReady,
            mcpReady: payload?["ok"] as? Bool == true,
            tunnelReady: tunnelReady,
            grantExpiresAt: grantExpiresAt,
            mcpToolCount: 20,
            mcpWriteToolCount: 0,
            externalRequest: external
        )
    }

    private func ensureGrant(projectID: String) async throws -> Bool {
        if let valid = try? existingGrant(projectID: projectID), valid.expiresAt.timeIntervalSinceNow > 300 {
            grantExpiresAt = valid.expiresAt
            try writeAuthorizationHeader(token: valid.token)
            return false
        }
        let issued = try await issueGrant(projectID: projectID)
        try tokenStore.store(issued.token, for: .chatGPTBridgeSession)
        try writeAuthorizationHeader(token: issued.token)
        grantExpiresAt = issued.expiresAt
        return true
    }

    private func existingGrant(projectID: String) throws -> (token: String, expiresAt: Date) {
        let token = try tokenStore.loadString(for: .chatGPTBridgeSession)
        let data = try Data(contentsOf: grantStoreURL)
        let values = try JSONDecoder().decode([StoredProjectGrant].self, from: data)
        let hash = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
        guard let grant = values.first(where: {
            $0.projectID == projectID && $0.tokenHash == hash && $0.revokedAt == nil
                && $0.scopes == ["project:read", "proposal:export"]
        }), let expiresAt = Self.iso8601Date(grant.expiresAt), expiresAt > Date() else {
            throw DesktopChatGPTRuntimeError.grantUnavailable
        }
        return (token, expiresAt)
    }

    private func issueGrant(projectID: String) async throws -> IssuedProjectGrant {
        let executable = grantCLIURL
        let workingDirectory = runtimeDirectory
        var environment = Self.safeBaseEnvironment()
        environment["FILMOS_CHATGPT_LOCAL_DIR"] = mcpDirectory.path
        let output = try await Task.detached(priority: .userInitiated) {
            try Self.runCapturedProcess(
                executable: executable,
                arguments: ["issue", projectID, "filmos-desktop", "60"],
                environment: environment,
                workingDirectory: workingDirectory
            )
        }.value
        guard
            output.count <= 65_536,
            let object = try JSONSerialization.jsonObject(with: output) as? [String: Any],
            let token = object["token"] as? String,
            let expiresText = object["expires_at"] as? String,
            let expiresAt = Self.iso8601Date(expiresText)
        else {
            throw DesktopChatGPTRuntimeError.grantUnavailable
        }
        return IssuedProjectGrant(token: token, expiresAt: expiresAt)
    }

    private func writeAuthorizationHeader(token: String) throws {
        let data = Data("Bearer \(token)\n".utf8)
        try data.write(to: authorizationHeaderURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: authorizationHeaderURL.path)
    }

    private func ensureService(
        _ id: ServiceID,
        runtimeEnvironment: ServiceRuntimeEnvironment = .empty,
        readiness: @escaping () async -> Bool
    ) async throws {
        if await readiness() { return }
        do {
            try supervisor.start(id, runtimeEnvironment: runtimeEnvironment)
            startedServices.insert(id)
        } catch {
            if await readiness() { throw DesktopChatGPTRuntimeError.portOwnedByAnotherProcess(id == filmCoreServiceID ? 17650 : 17840) }
            throw error
        }
        for _ in 0..<120 {
            try Task.checkCancellation()
            if await readiness() { return }
            if case .stopped = supervisor.state(for: id) { break }
            try await Task.sleep(for: .milliseconds(250))
        }
        throw DesktopChatGPTRuntimeError.serviceUnavailable
    }

    private func tunnelIsReady() async -> Bool {
        guard
            let data = try? Data(contentsOf: tunnelHealthURLFile),
            let value = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
            let baseURL = URL(string: value),
            baseURL.scheme == "http",
            ["127.0.0.1", "localhost", "::1"].contains(baseURL.host ?? ""),
            let readyURL = URL(string: "/readyz", relativeTo: baseURL)?.absoluteURL
        else { return false }
        return await Self.endpointReady(readyURL.absoluteString)
    }

    private static func tunnelArguments(
        mode: String,
        authorizationHeaderURL: URL,
        healthURLFile: URL,
        runtimeDirectory: URL
    ) -> [String] {
        var values = [
            mode,
            "--control-plane.api-key", "env:CONTROL_PLANE_API_KEY",
            "--mcp.server-url", "url=http://127.0.0.1:17840/mcp,channel=main",
            "--mcp.extra-headers", "Authorization: file:\(authorizationHeaderURL.path)",
            "--mcp.extra-headers", "X-FilmOS-Transport: secure-mcp-tunnel",
            "--mcp.extra-headers", "X-FilmOS-Transport-Proof: env:FILMOS_SECURE_TUNNEL_PROOF",
            "--mcp.extra-headers", "X-FilmOS-Live-Gate-Challenge: env:FILMOS_LIVE_GATE_CHALLENGE",
            "--mcp.discovery-extra-headers", "Authorization: file:\(authorizationHeaderURL.path)",
            "--mcp.discovery-extra-headers", "X-FilmOS-Transport: secure-mcp-tunnel",
            "--mcp.discovery-extra-headers", "X-FilmOS-Transport-Proof: env:FILMOS_SECURE_TUNNEL_PROOF",
            "--mcp.discovery-extra-headers", "X-FilmOS-Live-Gate-Challenge: env:FILMOS_LIVE_GATE_CHALLENGE",
            "--health.listen-addr", "127.0.0.1:0",
            "--health.url-file", healthURLFile.path,
            "--pid.file", runtimeDirectory.appendingPathComponent("tunnel-client.pid").path,
            "--log.format", "json",
            "--log.file", runtimeDirectory.appendingPathComponent("tunnel-runtime.log").path,
        ]
        if mode == "doctor" {
            values.insert(contentsOf: ["--json", "--explain"], at: 1)
        }
        return values
    }

    private static func tunnelRuntimeEnvironment(
        tunnelID: String,
        runtimeKey: String,
        transportProof: String,
        challengeID: String
    ) -> [String: String] {
        [
            "CONTROL_PLANE_TUNNEL_ID": tunnelID,
            "CONTROL_PLANE_API_KEY": runtimeKey,
            "FILMOS_SECURE_TUNNEL_PROOF": transportProof,
            "FILMOS_LIVE_GATE_CHALLENGE": challengeID,
        ]
    }

    private static func safeBaseEnvironment() -> [String: String] {
        let inherited = ProcessInfo.processInfo.environment
        var environment = [
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": inherited["LANG"] ?? "zh_CN.UTF-8",
        ]
        for key in ["HOME", "TMPDIR", "USER", "SHELL"] {
            if let value = inherited[key], !value.isEmpty { environment[key] = value }
        }
        return environment
    }

    private static func endpointReady(_ value: String) async -> Bool {
        guard let url = URL(string: value) else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch { return false }
    }

    private static func jsonPayload(_ value: String) async -> [String: Any]? {
        guard let url = URL(string: value) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private static func externalRequest(from payload: [String: Any]?) -> ChatGPTExternalRequest? {
        guard payload?["external_account_connected"] as? Bool == true,
              let timestampText = payload?["last_chatgpt_mcp_request_at"] as? String,
              let timestamp = iso8601Date(timestampText),
              let toolName = payload?["tool_name"] as? String,
              let requestID = payload?["request_id"] as? String,
              let projectScope = payload?["project_scope"] as? String else { return nil }
        return ChatGPTExternalRequest(
            timestamp: timestamp,
            toolName: toolName,
            requestID: requestID,
            projectScope: projectScope,
            challengeID: payload?["challenge_id"] as? String,
            resultHash: payload?["result_hash"] as? String
        )
    }

    private static func iso8601Date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    nonisolated private static func runQuietProcess(
        executable: URL,
        arguments: [String],
        environment: [String: String],
        workingDirectory: URL,
        timeout: TimeInterval
    ) -> Bool {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.currentDirectoryURL = workingDirectory
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return false }
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        if process.isRunning { process.terminate(); return false }
        return process.terminationStatus == 0
    }

    nonisolated private static func runCapturedProcess(
        executable: URL,
        arguments: [String],
        environment: [String: String],
        workingDirectory: URL
    ) throws -> Data {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.currentDirectoryURL = workingDirectory
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        let output = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw DesktopChatGPTRuntimeError.grantUnavailable }
        return output
    }
}

private struct StoredProjectGrant: Decodable {
    let projectID: String
    let tokenHash: String
    let expiresAt: String
    let revokedAt: String?
    let scopes: [String]

    enum CodingKeys: String, CodingKey {
        case projectID = "project_id"
        case tokenHash = "token_hash"
        case expiresAt = "expires_at"
        case revokedAt = "revoked_at"
        case scopes
    }
}

private struct IssuedProjectGrant {
    let token: String
    let expiresAt: Date
}

enum DesktopChatGPTRuntimeError: Error, LocalizedError {
    case missingHelper(String)
    case portOwnedByAnotherProcess(Int)
    case serviceUnavailable
    case grantUnavailable
    case tunnelDoctorFailed

    var errorDescription: String? {
        switch self {
        case let .missingHelper(name): "应用缺少内置连接组件：\(name)。"
        case let .portOwnedByAnotherProcess(port): "FilmOS 专用端口 \(port) 已被其他进程占用。"
        case .serviceUnavailable: "Film Core 或 MCP 未在预期时间内就绪。"
        case .grantUnavailable: "无法建立同一项目的只读 Project Grant。"
        case .tunnelDoctorFailed: "Secure Tunnel doctor 未通过。"
        }
    }
}
