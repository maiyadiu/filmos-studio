import Foundation
import Testing

@testable import FilmOSDesktopCore

struct InternalWorkbenchConfigurationTests {
    @Test
    func decodesSelfContainedLoopbackRuntime() throws {
        let configuration = try InternalWorkbenchConfiguration.decode(validConfiguration())

        #expect(configuration.startURL.absoluteString == "http://127.0.0.1:43100/create")
        #expect(configuration.applicationSupportDirectoryName == "FilmOS Studio")
        #expect(configuration.backendDataDirectoryName == "WorkbenchData")
    }

    @Test
    func rejectsNonLoopbackWorkbenchURL() {
        #expect(throws: InternalWorkbenchConfigurationError.invalidLoopbackURL) {
            try InternalWorkbenchConfiguration.decode(validConfiguration(startURL: "https://example.com/create"))
        }
    }

    @Test
    func rejectsDirectoryTraversalName() {
        #expect(throws: InternalWorkbenchConfigurationError.invalidDirectoryName) {
            try InternalWorkbenchConfiguration.decode(validConfiguration(dataDirectoryName: "../Downloads"))
        }
    }

    private func validConfiguration(
        startURL: String = "http://127.0.0.1:43100/create",
        dataDirectoryName: String = "WorkbenchData"
    ) -> Data {
        Data(
            """
            {
              "schema_version": 2,
              "start_url": "\(startURL)",
              "web_health_url": "http://127.0.0.1:43100/",
              "backend_health_url": "http://127.0.0.1:43101/api/health",
              "application_support_directory_name": "FilmOS Studio",
              "backend_data_directory_name": "\(dataDirectoryName)"
            }
            """.utf8
        )
    }
}
