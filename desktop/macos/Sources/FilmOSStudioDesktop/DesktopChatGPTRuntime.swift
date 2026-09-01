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
    private let reviewBusHealthURL: URL
    private var startedServices: Set<ServiceID> = []
    private var activeTransportProof: String?
    private var grantExpiresAt: Date?
    private var activeProjectID: String?
    private var activeGrantID: String?
    private var activeGrantToken: String?

    init(
        supervisor: ServiceSupervisor,
        helpersDirectory: URL,
        applicationRuntimeRoot: URL,
        reviewBusDirectory: URL,
        reviewBusHealthURL: URL,
        baseEnvironment: [String: String],
        tokenStore: any SecureTokenStoring = KeychainTokenStore()
    ) throws {
        self.supervisor = supervisor
        self.tokenStore = tokenStore
        self.reviewBusHealthURL = reviewBusHealthURL
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
        mcpEnvironment["FILMOS_CHATGPT_PROPOSAL_HANDOFF_ENABLED"] = baseEnvironment["FILMOS_CHATGPT_PROPOSAL_HANDOFF_ENABLED"] == "true" ? "true" : "false"
        mcpEnvironment["FILMOS_CHATGPT_HOST_PROFILE"] = "chatgpt.subscription.host.pro_readonly"
        mcpEnvironment["FILMOS_CHATGPT_CONNECTION_ID"] = "chatgpt.subscription.host"
        mcpEnvironment["FILMOS_CHATGPT_HOST"] = "127.0.0.1"
        mcpEnvironment["FILMOS_CHATGPT_PORT"] = "17840"
        mcpEnvironment["FILMOS_CHATGPT_LOCAL_DIR"] = mcpDirectory.path
        mcpEnvironment["FILMOS_CORE_BASE_URL"] = "http://127.0.0.1:17650/film"
        mcpEnvironment.merge(ReviewBusRuntimeContract.chatGPTReadEnvironment(reviewBusDirectory: reviewBusDirectory, healthURL: reviewBusHealthURL)) { _, review in review }
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
        try await prepareFilmCoreAuthority()
        _ = try await ensureFilmCoreProjection(projectID: projectID, contentUnitID: nil, contentUnitKind: nil, canvasID: nil)
        if let activeProjectID, activeProjectID != projectID {
            await disconnectHostSession()
            suspendTunnel()
            try await revokeActiveGrant()
            try? FileManager.default.removeItem(at: authorizationHeaderURL)
            try? tokenStore.delete(for: .chatGPTBridgeSession)
            grantExpiresAt = nil
            activeGrantToken = nil
            activeGrantID = nil
            self.activeProjectID = nil
        }
        let renewed = try await ensureGrant(projectID: projectID)
        guard await Self.endpointReady(reviewBusHealthURL.absoluteString) else {
            throw DesktopChatGPTRuntimeError.reviewBusUnavailable
        }
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

    func prepareFilmCoreAuthority() async throws {
        try await ensureService(filmCoreServiceID) { await Self.endpointReady("http://127.0.0.1:17650/health") }
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
        Task { await disconnectHostSession() }
        suspendTunnel()
    }

    func suspendTunnel() {
        guard startedServices.contains(secureTunnelServiceID), case .running = supervisor.state(for: secureTunnelServiceID) else {
            return
        }
        try? supervisor.stop(secureTunnelServiceID)
        startedServices.remove(secureTunnelServiceID)
        try? FileManager.default.removeItem(at: tunnelHealthURLFile)
    }

    func revokeProjectSession() async {
        await disconnectHostSession()
        stopTunnel()
        try? await revokeActiveGrant()
        try? FileManager.default.removeItem(at: authorizationHeaderURL)
        try? tokenStore.delete(for: .chatGPTBridgeSession)
        grantExpiresAt = nil
        activeProjectID = nil
        activeGrantID = nil
        activeGrantToken = nil
    }

    func stopOwnedServices() {
        let runningIDs = [secureTunnelServiceID, chatGPTMCPServiceID, filmCoreServiceID].filter { id in
            guard startedServices.contains(id), case .running = supervisor.state(for: id) else { return false }
            return true
        }
        try? supervisor.stopAll(runningIDs)
        startedServices.removeAll()
        try? FileManager.default.removeItem(at: tunnelHealthURLFile)
    }

    func runtimeHealth() async -> ChatGPTRuntimeHealth {
        let coreReady = await Self.endpointReady("http://127.0.0.1:17650/health")
        let healthPayload = await Self.jsonPayload("http://127.0.0.1:17840/health")
        let tunnelReady = await tunnelIsReady()
        let statusPayload: [String: Any]?
        if let token = activeGrantToken, let projectID = activeProjectID {
            statusPayload = await Self.jsonPayload(
                "http://127.0.0.1:17840/handoff/status?project_id=\(Self.urlQuery(projectID))",
                authorizationToken: token
            )
        } else {
            statusPayload = nil
        }
        let scopedProjectID = (statusPayload?["authorized_project"] as? [String: Any])?["project_id"] as? String
        let scopedGrantID = (statusPayload?["authorized_project"] as? [String: Any])?["grant_id"] as? String
        let external = tunnelReady && scopedProjectID == activeProjectID ? Self.externalRequest(from: statusPayload) : nil
        return ChatGPTRuntimeHealth(
            filmCoreReady: coreReady,
            mcpReady: healthPayload?["ok"] as? Bool == true,
            tunnelReady: tunnelReady,
            grantExpiresAt: grantExpiresAt,
            mcpToolCount: healthPayload?["mcp_tool_count"] as? Int ?? 0,
            mcpReadToolCount: healthPayload?["mcp_read_tool_count"] as? Int ?? 0,
            mcpWriteToolCount: healthPayload?["mcp_write_tool_count"] as? Int ?? 0,
            mcpPaidToolCount: healthPayload?["mcp_paid_tool_count"] as? Int ?? 0,
            mcpDestructiveToolCount: healthPayload?["mcp_destructive_tool_count"] as? Int ?? 0,
            grantID: scopedGrantID ?? activeGrantID,
            authorizedProjectID: scopedProjectID,
            profileID: healthPayload?["profile_id"] as? String ?? "chatgpt.subscription.host.pro_readonly",
            billingMode: healthPayload?["billing_mode"] as? String ?? "subscription_host_no_extra_model_api",
            proposalHandoffEnabled: healthPayload?["proposal_handoff_enabled"] as? Bool == true,
            externalRequest: external
        )
    }

    func publishHostContext(_ context: Data, challengeID: String) async throws -> Data {
        var value = try Self.jsonObject(context)
        guard let projectID = value["project_id"] as? String,
              projectID == activeProjectID else {
            throw DesktopChatGPTRuntimeError.hostPublishRejected(nil)
        }
        let contentUnitID = Self.optionalHostIdentifier(value["content_unit_id"])
        let canvasID = Self.optionalHostIdentifier(value["canvas_id"])
        let contentUnitKind = Self.contentUnitKind(value["content_unit_kind"])
        let filmContext = try await ensureFilmCoreProjection(
            projectID: projectID,
            contentUnitID: contentUnitID,
            contentUnitKind: contentUnitKind,
            canvasID: canvasID
        )
        guard let project = filmContext["film_project"] as? [String: Any],
              let ref = project["ref"] as? [String: Any],
              let version = ref["version"] as? Int,
              version > 0,
              let contentHash = ref["content_hash"] as? String,
              contentHash.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            throw DesktopChatGPTRuntimeError.filmCoreProjectionUnavailable
        }
        value["film_expected_version"] = version
        value["film_content_hash"] = contentHash
        value["context_receipt_id"] = try Self.liveContextReceipt(value)
        value.removeValue(forKey: "content_unit_kind")
        return try await publish(path: "/handoff/live-context", method: "PUT", challengeID: challengeID, key: "context", value: value)
    }

    func publishPendingHostHandoff(_ handoff: Data, challengeID: String) async throws -> Data {
        let value = try Self.jsonObject(handoff)
        return try await publish(path: "/handoff/pending-agent", method: "POST", challengeID: challengeID, key: "handoff", value: value)
    }

    private func publish(path: String, method: String, challengeID: String, key: String, value: [String: Any]) async throws -> Data {
        guard let token = activeGrantToken,
              let url = URL(string: "http://127.0.0.1:17840\(path)"),
              challengeID.range(of: "^live_[A-Za-z0-9_-]{8,96}$", options: .regularExpression) != nil else {
            throw DesktopChatGPTRuntimeError.hostPublishRejected(nil)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = try JSONSerialization.data(withJSONObject: ["challenge_id": challengeID, key: value])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw DesktopChatGPTRuntimeError.hostPublishRejected(nil)
        }
        let responseObject = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard (200..<300).contains(http.statusCode), responseObject != nil else {
            throw DesktopChatGPTRuntimeError.hostPublishRejected(responseObject?["code"] as? String)
        }
        return data
    }

    private static func jsonObject(_ data: Data) throws -> [String: Any] {
        guard data.count <= 256 * 1024,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DesktopChatGPTRuntimeError.hostPayloadInvalid
        }
        return value
    }

    private func ensureFilmCoreProjection(
        projectID: String,
        contentUnitID: String?,
        contentUnitKind: String?,
        canvasID: String?
    ) async throws -> [String: Any] {
        guard Self.isHostIdentifier(projectID) else { throw DesktopChatGPTRuntimeError.hostPayloadInvalid }
        var context = try await filmCoreProjectContext(projectID: projectID)
        if !(context["film_project"] is [String: Any]) {
            try await createFilmCoreEntity(
                entityType: "film_project_extension",
                host: ["host_project_id": projectID],
                unitKind: nil
            )
            context = try await filmCoreProjectContext(projectID: projectID)
        }
        if let contentUnitID {
            guard Self.isHostIdentifier(contentUnitID) else { throw DesktopChatGPTRuntimeError.hostPayloadInvalid }
            let mapped = (context["content_units"] as? [[String: Any]] ?? []).contains { unit in
                let host = unit["host"] as? [String: Any]
                return host?["host_project_id"] as? String == projectID
                    && host?["host_unit_id"] as? String == contentUnitID
            }
            if !mapped {
                var host = ["host_project_id": projectID, "host_unit_id": contentUnitID]
                if let canvasID, Self.isHostIdentifier(canvasID) { host["host_canvas_id"] = canvasID }
                try await createFilmCoreEntity(
                    entityType: "content_unit_extension",
                    host: host,
                    unitKind: contentUnitKind ?? "episode"
                )
                context = try await filmCoreProjectContext(projectID: projectID)
            }
        }
        guard let project = context["film_project"] as? [String: Any],
              let host = project["host"] as? [String: Any],
              host["host_project_id"] as? String == projectID else {
            throw DesktopChatGPTRuntimeError.filmCoreProjectionUnavailable
        }
        return context
    }

    private func filmCoreProjectContext(projectID: String) async throws -> [String: Any] {
        guard let url = URL(string: "http://127.0.0.1:17650/film/projects/\(Self.urlPath(projectID))/context") else {
            throw DesktopChatGPTRuntimeError.filmCoreProjectionUnavailable
        }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 5
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              http.statusCode == 200,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["host_project_id"] as? String == projectID else {
            throw DesktopChatGPTRuntimeError.filmCoreProjectionUnavailable
        }
        return value
    }

    private func createFilmCoreEntity(entityType: String, host: [String: String], unitKind: String?) async throws {
        guard let url = URL(string: "http://127.0.0.1:17650/film/commands/apply") else {
            throw DesktopChatGPTRuntimeError.filmCoreProjectionUnavailable
        }
        var payload: [String: Any] = [
            "entity_type": entityType,
            "host": host,
            "states": [
                "creative_stage": "draft",
                "execution_state": "not_started",
                "review_state": "not_reviewed",
                "lock_state": "unlocked",
                "delivery_state": "not_ready",
                "stale_state": "fresh",
            ],
        ]
        if let unitKind { payload["unit_kind"] = unitKind }
        let body: [String: Any] = [
            "command_type": "entity.create",
            "target_id": NSNull(),
            "expected_version": 0,
            "actor_kind": "system",
            "payload": payload,
        ]
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 5
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) || http.statusCode == 409 else {
            throw DesktopChatGPTRuntimeError.filmCoreProjectionUnavailable
        }
    }

    private static func liveContextReceipt(_ value: [String: Any]) throws -> String {
        var receiptValue = value
        receiptValue.removeValue(forKey: "context_receipt_id")
        receiptValue.removeValue(forKey: "content_unit_kind")
        guard JSONSerialization.isValidJSONObject(receiptValue) else { throw DesktopChatGPTRuntimeError.hostPayloadInvalid }
        let canonical = try JSONSerialization.data(withJSONObject: receiptValue, options: [.sortedKeys])
        let hash = SHA256.hash(data: canonical).map { String(format: "%02x", $0) }.joined()
        return "filmos-live:\(hash)"
    }

    private static func optionalHostIdentifier(_ value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? nil : normalized
    }

    private static func isHostIdentifier(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 256 && value.unicodeScalars.allSatisfy { scalar in
            scalar.value >= 0x20 && scalar.value != 0x7f
        }
    }

    private static func contentUnitKind(_ value: Any?) -> String? {
        guard let value = value as? String,
              ["chapter", "episode", "special", "trailer", "extra", "film", "season", "arc", "volume"].contains(value) else { return nil }
        return value
    }

    private func ensureGrant(projectID: String) async throws -> Bool {
        if let valid = try? existingGrant(projectID: projectID), valid.expiresAt.timeIntervalSinceNow > 300 {
            grantExpiresAt = valid.expiresAt
            try writeAuthorizationHeader(token: valid.token)
            activeProjectID = projectID
            activeGrantID = valid.grantID
            activeGrantToken = valid.token
            return false
        }
        let issued = try await issueGrant(projectID: projectID)
        try tokenStore.store(issued.token, for: .chatGPTBridgeSession)
        try writeAuthorizationHeader(token: issued.token)
        grantExpiresAt = issued.expiresAt
        activeProjectID = projectID
        activeGrantID = issued.grantID
        activeGrantToken = issued.token
        return true
    }

    private func existingGrant(projectID: String) throws -> (token: String, grantID: String, expiresAt: Date) {
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
        return (token, grant.grantID, expiresAt)
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
            let grantID = object["grant_id"] as? String,
            let expiresText = object["expires_at"] as? String,
            let expiresAt = Self.iso8601Date(expiresText)
        else {
            throw DesktopChatGPTRuntimeError.grantUnavailable
        }
        return IssuedProjectGrant(token: token, grantID: grantID, expiresAt: expiresAt)
    }

    private func revokeActiveGrant() async throws {
        guard let grantID = activeGrantID else { return }
        let executable = grantCLIURL
        let workingDirectory = runtimeDirectory
        var environment = Self.safeBaseEnvironment()
        environment["FILMOS_CHATGPT_LOCAL_DIR"] = mcpDirectory.path
        _ = try await Task.detached(priority: .userInitiated) {
            try Self.runCapturedProcess(executable: executable, arguments: ["revoke", grantID], environment: environment, workingDirectory: workingDirectory)
        }.value
    }

    private func disconnectHostSession() async {
        guard let token = activeGrantToken else { return }
        _ = await Self.jsonPayload("http://127.0.0.1:17840/handoff/disconnect", method: "POST", authorizationToken: token)
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

    private static func jsonPayload(_ value: String, method: String = "GET", authorizationToken: String? = nil) async -> [String: Any]? {
        guard let url = URL(string: value) else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if method == "POST" {
            request.httpBody = Data("{}".utf8)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let authorizationToken { request.setValue("Bearer \(authorizationToken)", forHTTPHeaderField: "Authorization") }
        request.timeoutInterval = 2
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private static func urlQuery(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
    }

    private static func urlPath(_ value: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
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
            resultHash: payload?["result_hash"] as? String,
            handoffID: payload?["handoff_id"] as? String,
            connectionID: payload?["connection_id"] as? String,
            mcpSessionID: payload?["mcp_session_id"] as? String,
            expiresAt: (payload?["observation_expires_at"] as? String).flatMap(iso8601Date)
        )
    }

    nonisolated private static func iso8601Date(_ value: String) -> Date? {
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
    let grantID: String
    let projectID: String
    let tokenHash: String
    let expiresAt: String
    let revokedAt: String?
    let scopes: [String]

    enum CodingKeys: String, CodingKey {
        case grantID = "grant_id"
        case projectID = "project_id"
        case tokenHash = "token_hash"
        case expiresAt = "expires_at"
        case revokedAt = "revoked_at"
        case scopes
    }
}

private struct IssuedProjectGrant {
    let token: String
    let grantID: String
    let expiresAt: Date
}

enum DesktopChatGPTRuntimeError: Error, LocalizedError {
    case missingHelper(String)
    case portOwnedByAnotherProcess(Int)
    case serviceUnavailable
    case reviewBusUnavailable
    case grantUnavailable
    case tunnelDoctorFailed
    case hostPayloadInvalid
    case filmCoreProjectionUnavailable
    case hostPublishRejected(String?)

    var bridgeErrorCode: String {
        switch self {
        case .hostPayloadInvalid:
            return "CHATGPT_HOST_PAYLOAD_INVALID"
        case .filmCoreProjectionUnavailable:
            return "CHATGPT_FILM_CORE_PROJECTION_UNAVAILABLE"
        case let .hostPublishRejected(upstreamCode):
            guard let upstreamCode,
                  upstreamCode.range(of: "^[A-Za-z0-9_]{1,80}$", options: .regularExpression) != nil else {
                return "CHATGPT_HOST_PUBLISH_REJECTED"
            }
            return "CHATGPT_HOST_\(upstreamCode.uppercased())"
        default:
            return "CHATGPT_HOST_REQUEST_FAILED"
        }
    }

    var errorDescription: String? {
        switch self {
        case let .missingHelper(name): "应用缺少内置连接组件：\(name)。"
        case let .portOwnedByAnotherProcess(port): "FilmOS 专用端口 \(port) 已被其他进程占用。"
        case .serviceUnavailable: "Film Core 或 MCP 未在预期时间内就绪。"
        case .reviewBusUnavailable: "Review Bus 未就绪，禁止启动缺失问题只读工具的 ChatGPT MCP。"
        case .grantUnavailable: "无法建立同一项目的只读 Project Grant。"
        case .tunnelDoctorFailed: "Secure Tunnel doctor 未通过。"
        case .hostPayloadInvalid: "ChatGPT Host 上下文格式无效。"
        case .filmCoreProjectionUnavailable: "当前工作台项目未能投影到 Film Core。"
        case .hostPublishRejected: "ChatGPT Host 上下文发布被安全边界拒绝。"
        }
    }
}
