import Foundation
import Testing

@testable import FilmOSDesktopCore

struct DesktopRPCContractTests {
    private let requestID = "11111111-1111-4111-8111-111111111111"
    private let submissionID = "FILMOS-SUBMISSION-b3274782-30a0-44a1-a05e-01730678da8b"

    @Test
    func parsesTheFiveLegacyActionsThroughOneExactContract() {
        let requests: [[String: Any]] = [
            ["action": "chatgptHostRequest", "requestId": requestID, "operation": "publish_context", "payload": ["project_id": "project-1"]],
            ["action": "reviewIssueRequest", "requestId": requestID, "payload": ["submission_id": submissionID]],
            ["action": "reviewIssueAttachmentRequest", "requestId": requestID, "submissionId": submissionID, "payload": ["base64": "aW1hZ2U="]],
            ["action": "reviewIssueFinalizeRequest", "requestId": requestID, "submissionId": submissionID, "payload": ["capture_hash": String(repeating: "a", count: 64)]],
            ["action": "reviewCenterRequest", "requestId": requestID, "operation": "list_issues", "payload": [String: String]()],
        ]
        #expect(requests.allSatisfy { DesktopRPCContract.parseRequest($0) != nil })
        #expect(DesktopRPCContract.parseRequest(["action": "reviewIssueRequest", "requestId": requestID, "payload": [:], "unexpected": true]) == nil)
        #expect(DesktopRPCContract.parseRequest(["action": "chatgptHostRequest", "requestId": requestID, "operation": "unknown", "payload": [:]]) == nil)
    }

    @Test
    func acceptsBothSuccessfulReviewBusStatusCodes() throws {
        let payload = Data(#"{"ok":true}"#.utf8)
        for status in [200, 201] {
            let result = try DesktopRPCContract.validateHTTPResponse(payload, response: response(status), allowedStatus: [200, 201], maximumBytes: 1024)
            #expect(result == payload)
        }
    }

    @Test
    func preservesBoundedServerCodesFor400409And500() {
        for status in [400, 409, 500] {
            let code = "REVIEW_BUS_STATUS_\(status)"
            let payload = Data("{\"code\":\"\(code)\"}".utf8)
            #expect(throws: DesktopRPCTransportError.server(code)) {
                try DesktopRPCContract.validateHTTPResponse(payload, response: response(status), allowedStatus: [200, 201], maximumBytes: 1024)
            }
        }
    }

    @Test
    func rejectsInvalidJSONAndOversizedResponses() {
        #expect(throws: DesktopRPCTransportError.invalidResponse) {
            try DesktopRPCContract.validateHTTPResponse(Data("not-json".utf8), response: response(200), allowedStatus: [200], maximumBytes: 1024)
        }
        #expect(throws: DesktopRPCTransportError.responseTooLarge) {
            try DesktopRPCContract.validateHTTPResponse(Data(repeating: 1, count: 1025), response: response(200), allowedStatus: [200], maximumBytes: 1024)
        }
    }

    @Test
    func mapsTimeoutAndUntrustedErrorsWithoutLeakingDetails() {
        #expect(DesktopRPCContract.secureErrorCode(URLError(.timedOut), fallback: "REVIEW_BUS_FAILED") == "DESKTOP_RPC_TIMEOUT")
        #expect(DesktopRPCContract.secureErrorCode(DesktopRPCTransportError.server("/Users/example/token"), fallback: "REVIEW_BUS_FAILED") == "DESKTOP_RPC_FAILED")
        #expect(DesktopRPCContract.secureErrorCode(NSError(domain: "private.path", code: 7), fallback: "/Users/example/token") == "DESKTOP_RPC_FAILED")
    }

    private func response(_ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: URL(string: "http://127.0.0.1:17920/review")!, statusCode: status, httpVersion: nil, headerFields: nil)!
    }
}
