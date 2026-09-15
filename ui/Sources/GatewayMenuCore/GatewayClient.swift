import Foundation

/// Thin client over the loopback gateway (default :3000).
/// All calls are GET/POST against 127.0.0.1 — no credentials needed locally
/// (GATEWAY_TOKEN only matters for remote-federated setups).
@MainActor
public final class GatewayClient: ObservableObject {
  @Published public var health: Health?
  @Published public var lastError: String?

  public let baseURL: URL

  public init() {
    let port = UserDefaults.standard.integer(forKey: "gatewayPort")
    let resolved = port == 0 ? 3000 : port
    baseURL = URL(string: "http://127.0.0.1:\(resolved)")!
  }

  private func get<T: Decodable>(_ path: String) async throws -> T {
    let (data, response) = try await URLSession.shared.data(from: baseURL.appendingPathComponent(path))
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
      throw URLError(.badServerResponse)
    }
    return try JSONDecoder().decode(T.self, from: data)
  }

  public func refreshHealth() async {
    do {
      health = try await get("health")
      lastError = nil
    } catch {
      lastError = "Gateway unreachable — is `serve` running?"
    }
  }

  public func search(_ q: String, harness: String?, maxResults: Int = 8) async throws -> SearchResponse {
    var items = [URLQueryItem(name: "q", value: q), URLQueryItem(name: "maxResults", value: String(maxResults))]
    if let h = harness, h != "all" { items.append(URLQueryItem(name: "harness", value: h)) }
    var comps = URLComponents(url: baseURL.appendingPathComponent("search"), resolvingAgainstBaseURL: false)!
    comps.queryItems = items
    let (data, _) = try await URLSession.shared.data(from: comps.url!)
    return try JSONDecoder().decode(SearchResponse.self, from: data)
  }

  public func decide(_ q: String) async throws -> DecideResponse {
    var comps = URLComponents(url: baseURL.appendingPathComponent("decide"), resolvingAgainstBaseURL: false)!
    comps.queryItems = [URLQueryItem(name: "q", value: q)]
    let (data, _) = try await URLSession.shared.data(from: comps.url!)
    return try JSONDecoder().decode(DecideResponse.self, from: data)
  }

  public func feedback(turnId: String, helpful: Bool) async {
    var comps = URLComponents(url: baseURL.appendingPathComponent("feedback"), resolvingAgainstBaseURL: false)!
    comps.queryItems = [URLQueryItem(name: "turnId", value: turnId), URLQueryItem(name: "helpful", value: helpful ? "true" : "false")]
    var req = URLRequest(url: comps.url!)
    req.httpMethod = "POST"
    _ = try? await URLSession.shared.data(for: req)
  }
}
