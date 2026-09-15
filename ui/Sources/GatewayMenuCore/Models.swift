import Foundation

// Mirrors the gateway's JSON envelope (CLI --json / HTTP / MCP).
// Unknown future keys are ignored (JSONDecoder default).

public struct Provenance: Codable {
  public var harness: String
  public var agentId: String
  public var sessionId: String
  public var turnId: String
  public var timestamp: String
  public var sourcePath: String
  public var byteOffset: Int?

  public var shortSession: String { String(sessionId.prefix(8)) }
}

public struct Turn: Codable, Identifiable {
  public var id: String
  public var sessionId: String
  public var harness: String
  public var timestamp: String
  public var role: String
  public var content: String
  public var fileRefs: [String]?
  public var seq: Int?
  public var byteOffset: Int?
}

public struct SearchResult: Codable, Identifiable {
  public var id: String { provenance.turnId }
  public var score: Double
  public var summary: String
  public var provenance: Provenance
  public var context: [Turn]
  public var artifacts: [String]
  public var via: String?
}

public struct SearchQuery: Codable {
  public var original: String
}

public struct SearchResponse: Codable {
  public var query: SearchQuery
  public var scope: String
  public var results: [SearchResult]
  public var searchedAt: String
}

public struct HealthSource: Codable {
  public var harness: String
  public var sessions: Int
}

public struct Health: Codable {
  public var ok: Bool
  public var backend: String
  public var docCount: Int
  public var perHarness: [String: Int]
  public var lastSync: String?
  public var sources: [HealthSource]
}

public struct DecisionConclusion: Codable {
  public var turnId: String
  public var timestamp: String
  public var content: String
}

public struct DecisionRationale: Codable {
  public var turnId: String
  public var content: String
  public var timestamp: String?
}

public struct Decision: Codable, Identifiable {
  public var id: String { conclusion.turnId }
  public var method: String
  public var confidence: Double
  public var session: DecisionSession
  public var conclusion: DecisionConclusion
  public var rationale: [DecisionRationale]
  public var alternatives: [DecisionRationale]
  public var question: DecisionRationale?
}

public struct DecisionSession: Codable {
  public var harness: String
  public var sessionId: String
}

public struct DecideResponse: Codable {
  public var query: String
  public var whyRouted: Bool
  public var decisions: [Decision]
  public var searchedAt: String
}
