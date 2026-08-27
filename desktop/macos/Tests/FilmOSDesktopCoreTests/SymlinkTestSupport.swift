import Foundation

@discardableResult
func createSymbolicLinkOrSkip(at url: URL, pointingTo destinationURL: URL) throws -> Bool {
    do {
        try FileManager.default.createSymbolicLink(at: url, withDestinationURL: destinationURL)
        return true
    } catch {
        let cocoaError = error as NSError
        let underlyingError = cocoaError.userInfo[NSUnderlyingErrorKey] as? NSError
        let unsupportedCode = Int(POSIXErrorCode.ENOTSUP.rawValue)
        if (cocoaError.domain == NSPOSIXErrorDomain && cocoaError.code == unsupportedCode)
            || (underlyingError?.domain == NSPOSIXErrorDomain && underlyingError?.code == unsupportedCode) {
            print("SKIP: temporary filesystem does not support symbolic links")
            return false
        }
        throw error
    }
}
