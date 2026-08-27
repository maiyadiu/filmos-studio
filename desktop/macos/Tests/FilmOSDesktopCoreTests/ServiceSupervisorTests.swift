import Foundation
import Testing

@testable import FilmOSDesktopCore

@MainActor
@Suite
struct ServiceSupervisorTests {
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

        try supervisor.start("backend")
        #expect(launcher.launchCount == 1)
        #expect(launcher.lastDefinition == definition)
        #expect(supervisor.state(for: "backend") == .running(processID: 4_242))

        try supervisor.stop("backend")
        #expect(process.terminateCalled)
        #expect(supervisor.state(for: "backend") == .stopped)
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

    init(result: Result<FakeManagedProcess, Error>) {
        self.result = result
    }

    func launch(_ definition: ServiceDefinition) throws -> any ManagedServiceProcess {
        launchCount += 1
        lastDefinition = definition
        return try result.get()
    }
}

@MainActor
private final class FakeManagedProcess: ManagedServiceProcess {
    let processIdentifier: Int32
    var isRunning = true
    private(set) var terminateCalled = false

    init(processIdentifier: Int32) {
        self.processIdentifier = processIdentifier
    }

    func terminate() {
        terminateCalled = true
        isRunning = false
    }
}

private enum TestLaunchError: Error {
    case failed
}
