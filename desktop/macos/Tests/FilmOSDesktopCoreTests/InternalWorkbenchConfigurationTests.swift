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
        #expect(configuration.agentRuntimeProfile == "integration")
        #expect(configuration.agentFeatureFlags.count == 10)
        #expect(configuration.releaseChannel == "development")
        #expect(configuration.externalPaidSubmitEnabled == false)
        #expect(configuration.reviewBusIssueURL.absoluteString == "http://127.0.0.1:17920/v1/issues")
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

    @Test
    func rejectsPartiallyEnabledAgentRuntimeProfile() {
        #expect(throws: InternalWorkbenchConfigurationError.inconsistentAgentFeatureFlags) {
            try InternalWorkbenchConfiguration.decode(validConfiguration(genericRuntime: true))
        }
    }

    private func validConfiguration(
        startURL: String = "http://127.0.0.1:43100/create",
        dataDirectoryName: String = "WorkbenchData",
        genericRuntime: Bool = false
    ) -> Data {
        Data(
            """
            {
              "schema_version": 3,
              "start_url": "\(startURL)",
              "web_health_url": "http://127.0.0.1:43100/",
              "backend_health_url": "http://127.0.0.1:43101/api/health",
              "review_bus_health_url": "http://127.0.0.1:17920/healthz",
              "review_bus_issue_url": "http://127.0.0.1:17920/v1/issues",
              "application_support_directory_name": "FilmOS Studio",
              "backend_data_directory_name": "\(dataDirectoryName)",
              "agent_runtime_profile": "integration",
              "source_commit": "6ea93bfa08381264a1379fe938ade3a7513c7bba",
              "release_channel": "development",
              "build_id": "development-6ea93bfa-51896f78",
              "external_paid_submit_enabled": false,
              "agent_feature_flags_hash": "b853a8f3ceb6b61d306e3c13b885252bae68178368e61bed7ce8bc9f0678605d",
              "agent_feature_flags": {
                "film.agent_native_brain_selector": false,
                "film.agent_generic_runtime": \(genericRuntime),
                "film.agent_context_broker": false,
                "film.agent_canonical_tool_manifest": false,
                "film.agent_canonical_tool_broker": false,
                "film.agent_codex_subscription": false,
                "film.agent_chatgpt_host": false,
                "film.agent_model_api_profiles": false,
                "film.agent_no_silent_api_fallback": false,
                "film.agent_request_scoped_identity": false
              }
            }
            """.utf8
        )
    }
}
