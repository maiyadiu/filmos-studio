import Darwin
import Foundation
import Testing

@testable import FilmOSDesktopCore

@MainActor
@Suite
struct ServiceSupervisorTests {
    @Test
    func foundationLauncherWaitsForOwnedProcessAndEscalatesBoundedly() throws {
        let policy = try ServiceLaunchPolicy(
            allowedExecutableRoots: [URL(fileURLWithPath: "/bin", isDirectory: true)],
            allowedWorkingDirectoryRoots: [URL(fileURLWithPath: "/tmp", isDirectory: true)]
        )
        let supervisor = ServiceSupervisor(policy: policy)
        try supervisor.register(ServiceDefinition(
            id: "owned-process",
            displayName: "Owned Process",
            executableURL: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "trap '' TERM; exec /bin/sleep 60"],
            workingDirectoryURL: URL(fileURLWithPath: "/tmp", isDirectory: true)
        ))

        try supervisor.start("owned-process")
        guard case let .running(processID) = supervisor.state(for: "owned-process") else {
            Issue.record("Expected owned process to be running")
            return
        }
        #expect(Darwin.kill(processID, 0) == 0)

        try supervisor.stop("owned-process")

        #expect(supervisor.state(for: "owned-process") == .stopped)
        #expect(Darwin.kill(processID, 0) == -1)
    }

    @Test
    func controlledServiceLifecycleUsesInjectedLauncher() throws {
        let workspaceRoot = URL(fileURLWithPath: "/tmp/FilmOSSupervisorTests", isDirectory: true)
        let policy = try ServiceLaunchPolicy(
            allowedExecutableRoots: [URL(fileURLWithPath: "/usr/bin", isDirectory: true)],
            allowedWorkingDirectoryRoots: [workspaceRoot]
        )
        let process = FakeManagedProcess(processIdentifier: 4_242)
        let launcher = FakeLauncher(result: .success(process))
        let supervisor = ServiceSupervisor(policy: policy, launcher: launcher)
        let definition = ServiceDefinition(
            id: "backend",
            displayName: "Yingce Backend",
            executableURL: URL(fileURLWithPath: "/usr/bin/true"),
            arguments: ["--version"],
            workingDirectoryURL: workspaceRoot,
            environment: ["CANVAS_BACKEND_ADDR": "127.0.0.1:8080"]
        )

        try supervisor.register(definition)
        #expect(supervisor.state(for: "backend") == .stopped)
        let registeredDefinition = try #require(supervisor.registeredServices().first)

        try supervisor.start("backend")
        #expect(launcher.launchCount == 1)
        #expect(launcher.lastDefinition == registeredDefinition)
        #expect(supervisor.state(for: "backend") == .running(processID: 4_242))

        try supervisor.stop("backend")
        #expect(process.terminateCalled)
        #expect(supervisor.state(for: "backend") == .stopped)
    }

    @Test
    func batchStopRequestsEveryChildBeforeUsingOneSharedEscalationWindow() throws {
        let workspaceRoot = URL(fileURLWithPath: "/tmp/FilmOSSupervisorBatchTests", isDirectory: true)
        let policy = try ServiceLaunchPolicy(
            allowedExecutableRoots: [URL(fileURLWithPath: "/usr/bin", isDirectory: true)],
            allowedWorkingDirectoryRoots: [workspaceRoot]
        )
        let recorder = TerminationRecorder()
        let first = FakeManagedProcess(
            processIdentifier: 5_001,
            stopsOnRequest: false,
            label: "first",
            recorder: recorder
        )
        let second = FakeManagedProcess(
            processIdentifier: 5_002,
            stopsOnRequest: false,
            label: "second",
            recorder: recorder
        )
        let launcher = SequenceFakeLauncher(processes: [first, second])
        let supervisor = ServiceSupervisor(policy: policy, launcher: launcher)
        let serviceIDs: [ServiceID] = ["first", "second"]
        for id in serviceIDs {
            try supervisor.register(ServiceDefinition(
                id: id,
                displayName: id.rawValue,
                executableURL: URL(fileURLWithPath: "/usr/bin/true"),
                workingDirectoryURL: workspaceRoot
            ))
            try supervisor.start(id)
        }

        try supervisor.stopAll(["first", "second"], gracePeriod: 0.01)

        #expect(recorder.events == ["request:first", "request:second", "force:first", "force:second"])
        #expect(supervisor.state(for: "first") == .stopped)
        #expect(supervisor.state(for: "second") == .stopped)
    }

    @Test
    func rejectsExecutableOutsidePolicyBeforeLaunch() throws {
        let policy = try ServiceLaunchPolicy(
            allowedExecutableRoots: [URL(fileURLWithPath: "/usr/bin", isDirectory: true)],
            allowedWorkingDirectoryRoots: [URL(fileURLWithPath: "/tmp/work", isDirectory: true)]
        )
        let launcher = FakeLauncher(result: .success(FakeManagedProcess(processIdentifier: 1)))
        let supervisor = ServiceSupervisor(policy: policy, launcher: launcher)
        let definition = ServiceDefinition(
            id: "backend",
            displayName: "Backend",
            executableURL: URL(fileURLWithPath: "/bin/sh"),
            workingDirectoryURL: URL(fileURLWithPath: "/tmp/work", isDirectory: true)
        )

        do {
            try supervisor.register(definition)
            Issue.record("Expected executable policy rejection")
        } catch {
            #expect(error as? ServiceSupervisorError == .executableOutsidePolicy)
        }
        #expect(launcher.launchCount == 0)
    }

    @Test
    func rejectsExecutableSymlinkThatEscapesAllowedRoot() throws {
        let sandbox = FileManager.default.temporaryDirectory
            .appendingPathComponent("FilmOSServiceSymlinkTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let allowedRoot = sandbox.appendingPathComponent("allowed", isDirectory: true)
        let outsideRoot = sandbox.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: allowedRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outsideRoot, withIntermediateDirectories: true)
        let outsideExecutable = outsideRoot.appendingPathComponent("tool")
        try Data("not executed".utf8).write(to: outsideExecutable)
        let linkedExecutable = allowedRoot.appendingPathComponent("tool")
        guard try createSymbolicLinkOrSkip(at: linkedExecutable, pointingTo: outsideExecutable) else { return }

        let policy = try ServiceLaunchPolicy(
            allowedExecutableRoots: [allowedRoot],
            allowedWorkingDirectoryRoots: [allowedRoot]
        )
        let launcher = FakeLauncher(result: .success(FakeManagedProcess(processIdentifier: 1)))
        let supervisor = ServiceSupervisor(policy: policy, launcher: launcher)

        do {
            try supervisor.register(
                ServiceDefinition(
                    id: "backend",
                    displayName: "Backend",
                    executableURL: linkedExecutable,
                    workingDirectoryURL: allowedRoot
                )
            )
            Issue.record("Expected canonical executable policy rejection")
        } catch {
            #expect(error as? ServiceSupervisorError == .executableOutsidePolicy)
        }
        #expect(launcher.launchCount == 0)
    }

    @Test
    func rejectsWorkingDirectorySymlinkThatEscapesAllowedRoot() throws {
        let sandbox = FileManager.default.temporaryDirectory
            .appendingPathComponent("FilmOSWorkdirSymlinkTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let allowedRoot = sandbox.appendingPathComponent("allowed", isDirectory: true)
        let outsideRoot = sandbox.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: allowedRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outsideRoot, withIntermediateDirectories: true)
        let linkedWorkingDirectory = allowedRoot.appendingPathComponent("work", isDirectory: true)
        guard try createSymbolicLinkOrSkip(at: linkedWorkingDirectory, pointingTo: outsideRoot) else { return }

        let policy = try ServiceLaunchPolicy(
            allowedExecutableRoots: [URL(fileURLWithPath: "/usr/bin", isDirectory: true)],
            allowedWorkingDirectoryRoots: [allowedRoot]
        )
        let launcher = FakeLauncher(result: .success(FakeManagedProcess(processIdentifier: 1)))
        let supervisor = ServiceSupervisor(policy: policy, launcher: launcher)

        do {
            try supervisor.register(
                ServiceDefinition(
                    id: "backend",
                    displayName: "Backend",
                    executableURL: URL(fileURLWithPath: "/usr/bin/true"),
                    workingDirectoryURL: linkedWorkingDirectory
                )
            )
            Issue.record("Expected canonical working directory policy rejection")
        } catch {
            #expect(error as? ServiceSupervisorError == .workingDirectoryOutsidePolicy)
        }
        #expect(launcher.launchCount == 0)
    }

    @Test
    func rejectsSensitiveEnvironmentInPersistableDefinition() throws {
        let policy = try ServiceLaunchPolicy(
            allowedExecutableRoots: [URL(fileURLWithPath: "/usr/bin", isDirectory: true)],
            allowedWorkingDirectoryRoots: [URL(fileURLWithPath: "/tmp/work", isDirectory: true)]
        )
        let launcher = FakeLauncher(result: .success(FakeManagedProcess(processIdentifier: 1)))
        let supervisor = ServiceSupervisor(policy: policy, launcher: launcher)
        let definition = ServiceDefinition(
            id: "runtime",
            displayName: "Local Runtime",
            executableURL: URL(fileURLWithPath: "/usr/bin/true"),
            workingDirectoryURL: URL(fileURLWithPath: "/tmp/work", isDirectory: true),
            environment: ["API_TOKEN": "must-not-be-here"]
        )

        do {
            try supervisor.register(definition)
            Issue.record("Expected sensitive environment rejection")
        } catch {
            #expect(error as? ServiceSupervisorError == .invalidEnvironment)
        }
        #expect(launcher.launchCount == 0)
    }

    @Test
    func runtimeTunnelCredentialIsInjectedWithoutPersistingOrEnteringArguments() throws {
        let policy = try ServiceLaunchPolicy(
            allowedExecutableRoots: [URL(fileURLWithPath: "/usr/bin", isDirectory: true)],
            allowedWorkingDirectoryRoots: [URL(fileURLWithPath: "/tmp/work", isDirectory: true)]
        )
        let launcher = FakeLauncher(result: .success(FakeManagedProcess(processIdentifier: 22)))
        let supervisor = ServiceSupervisor(policy: policy, launcher: launcher)
        try supervisor.register(
            ServiceDefinition(
                id: "secure-tunnel",
                displayName: "Secure MCP Tunnel",
                executableURL: URL(fileURLWithPath: "/usr/bin/true"),
                arguments: ["--control-plane.api-key", "env:CONTROL_PLANE_API_KEY"],
                workingDirectoryURL: URL(fileURLWithPath: "/tmp/work", isDirectory: true)
            )
        )
        let runtime = try ServiceRuntimeEnvironment(
            values: [
                "CONTROL_PLANE_API_KEY": "sk-runtime-secret-do-not-log",
                "CONTROL_PLANE_TUNNEL_ID": "tunnel_test",
            ],
            secretKeys: ["CONTROL_PLANE_API_KEY"]
        )

        try supervisor.start("secure-tunnel", runtimeEnvironment: runtime)

        #expect(supervisor.registeredServices().first?.environment["CONTROL_PLANE_API_KEY"] == nil)
        #expect(launcher.lastDefinition?.arguments.contains("sk-runtime-secret-do-not-log") == false)
        #expect(launcher.lastRuntimeEnvironment?.values["CONTROL_PLANE_API_KEY"] == "sk-runtime-secret-do-not-log")
        #expect(runtime.redactedDescription["CONTROL_PLANE_API_KEY"] == "[REDACTED]")
        #expect(runtime.redactedDescription["CONTROL_PLANE_TUNNEL_ID"] == "tunnel_test")
    }

    @Test
    func runtimeEnvironmentRejectsUnsupportedSecretsAndSensitivePlainValues() {
        #expect(throws: ServiceSupervisorError.invalidEnvironment) {
            _ = try ServiceRuntimeEnvironment(values: ["OPENAI_API_KEY": "secret"], secretKeys: [])
        }
        #expect(throws: ServiceSupervisorError.invalidEnvironment) {
            _ = try ServiceRuntimeEnvironment(values: ["OPENAI_API_KEY": "secret"], secretKeys: ["OPENAI_API_KEY"])
        }
    }

    @Test
    func failedLaunchProducesExplicitState() throws {
        let policy = try ServiceLaunchPolicy(
            allowedExecutableRoots: [URL(fileURLWithPath: "/usr/bin", isDirectory: true)],
            allowedWorkingDirectoryRoots: [URL(fileURLWithPath: "/tmp/work", isDirectory: true)]
        )
        let launcher = FakeLauncher(result: .failure(TestLaunchError.failed))
        let supervisor = ServiceSupervisor(policy: policy, launcher: launcher)
        try supervisor.register(
            ServiceDefinition(
                id: "runtime",
                displayName: "Local Runtime",
                executableURL: URL(fileURLWithPath: "/usr/bin/true"),
                workingDirectoryURL: URL(fileURLWithPath: "/tmp/work", isDirectory: true)
            )
        )

        do {
            try supervisor.start("runtime")
            Issue.record("Expected launch failure")
        } catch {
            #expect(error as? ServiceSupervisorError == .launchFailed)
        }
        #expect(supervisor.state(for: "runtime") == .failed(message: "Service failed to launch."))
        #expect(launcher.launchCount == 1)
    }
}

@MainActor
private final class FakeLauncher: ServiceProcessLaunching {
    let result: Result<FakeManagedProcess, Error>
    private(set) var launchCount = 0
    private(set) var lastDefinition: ServiceDefinition?
    private(set) var lastRuntimeEnvironment: ServiceRuntimeEnvironment?

    init(result: Result<FakeManagedProcess, Error>) {
        self.result = result
    }

    func launch(
        _ definition: ServiceDefinition,
        runtimeEnvironment: ServiceRuntimeEnvironment
    ) throws -> any ManagedServiceProcess {
        launchCount += 1
        lastDefinition = definition
        lastRuntimeEnvironment = runtimeEnvironment
        return try result.get()
    }
}

@MainActor
private final class FakeManagedProcess: ManagedServiceProcess {
    let processIdentifier: Int32
    var isRunning = true
    private(set) var terminateCalled = false
    private(set) var forceTerminationCalled = false
    private let stopsOnRequest: Bool
    private let label: String
    private let recorder: TerminationRecorder?

    init(
        processIdentifier: Int32,
        stopsOnRequest: Bool = true,
        label: String = "process",
        recorder: TerminationRecorder? = nil
    ) {
        self.processIdentifier = processIdentifier
        self.stopsOnRequest = stopsOnRequest
        self.label = label
        self.recorder = recorder
    }

    func requestTermination() {
        terminateCalled = true
        recorder?.events.append("request:\(label)")
        if stopsOnRequest { isRunning = false }
    }

    func forceTermination() {
        forceTerminationCalled = true
        recorder?.events.append("force:\(label)")
        isRunning = false
    }
}

@MainActor
private final class SequenceFakeLauncher: ServiceProcessLaunching {
    private var processes: [FakeManagedProcess]

    init(processes: [FakeManagedProcess]) {
        self.processes = processes
    }

    func launch(
        _ definition: ServiceDefinition,
        runtimeEnvironment: ServiceRuntimeEnvironment
    ) throws -> any ManagedServiceProcess {
        guard !processes.isEmpty else { throw TestLaunchError.failed }
        return processes.removeFirst()
    }
}

@MainActor
private final class TerminationRecorder {
    var events: [String] = []
}

private enum TestLaunchError: Error {
    case failed
}
