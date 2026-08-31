import Foundation
import Testing
@testable import FilmOSDesktopCore

@Suite("External URL request queue")
struct ExternalURLRouterTests {
    @Test("serializes different web URLs and de-duplicates repeats")
    func serializesAndDeduplicates() throws {
        let first = try #require(URL(string: "https://chatgpt.com/"))
        let second = try #require(URL(string: "https://platform.openai.com/settings/organization/tunnels"))
        var queue = ExternalURLRequestQueue()

        #expect(queue.enqueue(first) == first)
        #expect(queue.enqueue(first) == nil)
        #expect(queue.enqueue(second) == nil)
        #expect(queue.enqueue(second) == nil)
        #expect(queue.activeURL == first)
        #expect(queue.completeActiveRequest() == second)
        #expect(queue.completeActiveRequest() == nil)
    }

    @Test("rejects non-web URLs")
    func rejectsNonWebURLs() throws {
        let fileURL = URL(fileURLWithPath: "/tmp/filmos")
        let customURL = try #require(URL(string: "filmos://review"))
        var queue = ExternalURLRequestQueue()

        #expect(queue.enqueue(fileURL) == nil)
        #expect(queue.enqueue(customURL) == nil)
        #expect(queue.activeURL == nil)
    }
}
