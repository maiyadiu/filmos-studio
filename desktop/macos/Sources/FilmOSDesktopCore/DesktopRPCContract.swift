import Foundation

public enum DesktopRPCRequest {
    case chatGPTHost(requestID: String, operation: String, payload: Data)
    case reviewIssue(requestID: String, payload: Data)
    case reviewIssueAttachment(requestID: String, submissionID: String, payload: Data)
    case reviewIssueFinalize(requestID: String, submissionID: String, payload: Data)
    case reviewCenter(requestID: String, operation: String, payload: [String: String])
}

public enum DesktopRPCTransportError: Error, Equatable {
    case invalidResponse
    case responseTooLarge
    case server(String)
    case timedOut

    public var code: String {
        switch self {
        case .invalidResponse: "DESKTOP_RPC_INVALID_RESPONSE"
        case .responseTooLarge: "DESKTOP_RPC_RESPONSE_TOO_LARGE"
        case let .server(code): code
        case .timedOut: "DESKTOP_RPC_TIMEOUT"
        }
    }
}

public enum DesktopRPCContract {
    public static func parseRequest(_ body: [String: Any]) -> DesktopRPCRequest? {
        guard let action = body["action"] as? String,
              let contract = ReviewProtocolContract.desktopActions[action],
              exactKeys(body, contract.requiredKeys)
        else { return nil }
        switch action {
        case "chatgptHostRequest":
            guard let requestID = validRequestID(body["requestId"]),
                  let operation = body["operation"] as? String,
                  contract.operations.contains(operation),
                  let payload = encodedObject(body["payload"], maximumBytes: contract.maximumPayloadBytes)
            else { return nil }
            return .chatGPTHost(requestID: requestID, operation: operation, payload: payload)
        case "reviewIssueRequest":
            guard let requestID = validRequestID(body["requestId"]),
                  let payload = encodedObject(body["payload"], maximumBytes: contract.maximumPayloadBytes)
            else { return nil }
            return .reviewIssue(requestID: requestID, payload: payload)
        case "reviewIssueAttachmentRequest":
            guard let requestID = validRequestID(body["requestId"]),
                  let submissionID = validSubmissionID(body["submissionId"]),
                  let payload = encodedObject(body["payload"], maximumBytes: contract.maximumPayloadBytes)
            else { return nil }
            return .reviewIssueAttachment(requestID: requestID, submissionID: submissionID, payload: payload)
        case "reviewIssueFinalizeRequest":
            guard let requestID = validRequestID(body["requestId"]),
                  let submissionID = validSubmissionID(body["submissionId"]),
                  let payload = encodedObject(body["payload"], maximumBytes: contract.maximumPayloadBytes)
            else { return nil }
            return .reviewIssueFinalize(requestID: requestID, submissionID: submissionID, payload: payload)
        case "reviewCenterRequest":
            guard let requestID = validRequestID(body["requestId"]),
                  let operation = body["operation"] as? String,
                  !operation.isEmpty,
                  operation.count <= 128,
                  let payload = body["payload"] as? [String: String],
                  let bytes = try? JSONSerialization.data(withJSONObject: payload),
                  bytes.count <= contract.maximumPayloadBytes
            else { return nil }
            return .reviewCenter(requestID: requestID, operation: operation, payload: payload)
        default:
            return nil
        }
    }

    public static func validateHTTPResponse(
        _ data: Data,
        response: URLResponse,
        allowedStatus: Set<Int>,
        maximumBytes: Int
    ) throws -> Data {
        guard data.count <= maximumBytes else { throw DesktopRPCTransportError.responseTooLarge }
        guard let http = response as? HTTPURLResponse,
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw DesktopRPCTransportError.invalidResponse }
        guard allowedStatus.contains(http.statusCode) else {
            let rawCode = payload["code"] as? String ?? "DESKTOP_RPC_UPSTREAM_REJECTED"
            let code = isSafeErrorCode(rawCode) ? rawCode : "DESKTOP_RPC_UPSTREAM_REJECTED"
            throw DesktopRPCTransportError.server(code)
        }
        return data
    }

    public static func secureErrorCode(_ error: Error, fallback: String) -> String {
        if let transport = error as? DesktopRPCTransportError {
            return isSafeErrorCode(transport.code) ? transport.code : "DESKTOP_RPC_FAILED"
        }
        if let urlError = error as? URLError, urlError.code == .timedOut { return DesktopRPCTransportError.timedOut.code }
        return isSafeErrorCode(fallback) ? fallback : "DESKTOP_RPC_FAILED"
    }

    private static func exactKeys(_ body: [String: Any], _ keys: Set<String>) -> Bool {
        Set(body.keys) == keys
    }

    private static func validRequestID(_ value: Any?) -> String? {
        guard let value = value as? String,
              value.range(of: ReviewProtocolContract.desktopRequestIDPattern, options: .regularExpression) != nil else { return nil }
        return value
    }

    private static func validSubmissionID(_ value: Any?) -> String? {
        guard let value = value as? String,
              value.range(of: ReviewProtocolContract.submissionIDPattern, options: .regularExpression) != nil else { return nil }
        return value
    }

    private static func encodedObject(_ value: Any?, maximumBytes: Int) -> Data? {
        guard let value = value as? [String: Any],
              JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              data.count <= maximumBytes else { return nil }
        return data
    }

    private static func isSafeErrorCode(_ value: String) -> Bool {
        value.range(of: ReviewProtocolContract.errorCodePattern, options: .regularExpression) != nil
    }
}
