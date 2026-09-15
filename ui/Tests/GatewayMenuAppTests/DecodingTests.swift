import XCTest
@testable import GatewayMenuCore

/// Live decoding tests against the loopback gateway (default :3000).
/// Skipped automatically when no gateway is serving (CI without data).
final class GatewayDecodingTests: XCTestCase {
  private func gatewayUp() async -> Bool {
    guard let url = URL(string: "http://127.0.0.1:3000/health") else { return false }
    do {
      let (data, _) = try await URLSession.shared.data(from: url)
      return (try? JSONDecoder().decode(Health.self, from: data))?.ok == true
    } catch {
      return false
    }
  }

  func testHealthDecodes() async throws {
    let up = await gatewayUp()
    try XCTSkipUnless(up, "no live gateway on :3000")
    let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:3000/health")!)
    let health = try JSONDecoder().decode(Health.self, from: data)
    XCTAssertTrue(health.ok)
    XCTAssertGreaterThan(health.docCount, 0)
  }

  func testSearchDecodes() async throws {
    let up = await gatewayUp()
    try XCTSkipUnless(up, "no live gateway on :3000")
    var comps = URLComponents(string: "http://127.0.0.1:3000/search")!
    comps.queryItems = [URLQueryItem(name: "q", value: "collaboration"), URLQueryItem(name: "maxResults", value: "2")]
    let (data, _) = try await URLSession.shared.data(from: comps.url!)
    let res = try JSONDecoder().decode(SearchResponse.self, from: data)
    XCTAssertFalse(res.results.isEmpty)
    XCTAssertFalse(res.results[0].provenance.turnId.isEmpty)
  }

  func testDecideDecodes() async throws {
    let up = await gatewayUp()
    try XCTSkipUnless(up, "no live gateway on :3000")
    var comps = URLComponents(string: "http://127.0.0.1:3000/decide")!
    comps.queryItems = [URLQueryItem(name: "q", value: "why workbench private")]
    let (data, _) = try await URLSession.shared.data(from: comps.url!)
    let res = try JSONDecoder().decode(DecideResponse.self, from: data)
    XCTAssertEqual(res.query, "why workbench private")
  }
}
