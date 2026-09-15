import SwiftUI
import AppKit
import GatewayMenuCore

struct SearchView: View {
  @ObservedObject var client: GatewayClient
  @State private var query = ""
  @State private var harness = "all"
  @State private var mode = 0 // 0 search, 1 decide
  @State private var results: [SearchResult] = []
  @State private var decisions: [Decision] = []
  @State private var searching = false
  @State private var selection: String?
  @State private var copiedNotice: String?

  var body: some View {
    VStack(spacing: 8) {
      // Top status & hotkey bar
      HStack {
        Circle()
          .fill(client.health?.ok == true ? Color.green : Color.orange)
          .frame(width: 8, height: 8)
        if let h = client.health {
          Text("\(formattedNumber(h.docCount)) turns")
            .font(.caption2.monospaced())
            .foregroundStyle(.secondary)
        } else {
          Text("Connecting...")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        Spacer()
        if let notice = copiedNotice {
          Text(notice)
            .font(.caption2.bold())
            .foregroundStyle(.green)
        }
        Text("⌘⇧K")
          .font(.caption2.monospaced())
          .padding(.horizontal, 4)
          .padding(.vertical, 1)
          .background(Color.secondary.opacity(0.15))
          .cornerRadius(4)
      }
      .padding(.horizontal, 2)

      Picker("", selection: $mode) {
        Text("Search").tag(0)
        Text("Decisions (Why)").tag(1)
      }
      .pickerStyle(.segmented)

      HStack {
        TextField(mode == 0 ? "What did the other agent decide?" : "Why did we reject X?", text: $query)
          .textFieldStyle(.roundedBorder)
          .onSubmit(run)
        Picker("", selection: $harness) {
          Text("All").tag("all")
          Text("Codex").tag("codex")
          Text("Claude").tag("claude-code")
          Text("Cursor").tag("cursor")
          Text("Zep").tag("zep")
          Text("Git").tag("git")
        }
        .frame(width: 100)
        Button("Go") { run() }.keyboardShortcut(.defaultAction)
      }

      if searching { ProgressView().scaleEffect(0.7) }

      if mode == 0 {
        List(results, selection: $selection) { r in
          VStack(alignment: .leading, spacing: 2) {
            HStack {
              Text(String(format: "%.3f", r.score)).font(.caption.monospaced()).foregroundStyle(.secondary)
              Text(r.provenance.harness.uppercased()).font(.caption2).bold()
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .background(Color.accentColor.opacity(0.15))
                .cornerRadius(3)
              Text(r.provenance.shortSession).font(.caption).foregroundStyle(.secondary)
              if let via = r.via { Text("via \(via)").font(.caption).foregroundStyle(.tertiary) }
            }
            Text(r.summary).font(.body).lineLimit(3)
            Text("\(r.context.count) turns · \(r.provenance.timestamp)").font(.caption2).foregroundStyle(.secondary)
          }
          .tag(r.id)
        }
        if let r = selectedResult {
          Divider()
          ScrollView {
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                Text("Evidence (\(r.context.count) turns)").font(.caption).bold()
                Spacer()
                Button("Copy ID") {
                  copyToClipboard(r.provenance.turnId, notice: "Turn ID Copied!")
                }
                .buttonStyle(.borderless)
                .font(.caption2)
                Button("Copy Markdown") {
                  copyToClipboard(formatMarkdownEvidence(r), notice: "Markdown Copied!")
                }
                .buttonStyle(.borderless)
                .font(.caption2)
              }
              ForEach(r.context.prefix(7)) { t in
                VStack(alignment: .leading, spacing: 2) {
                  Text(t.role.uppercased()).font(.caption2).bold().foregroundStyle(.secondary)
                  Text(t.content).font(.callout).textSelection(.enabled)
                  Divider()
                }
              }
              if !r.artifacts.isEmpty {
                Text("Artifacts: " + r.artifacts.joined(separator: " · "))
                  .font(.caption2)
                  .foregroundStyle(.secondary)
                  .textSelection(.enabled)
              }
              HStack {
                Button("Helpful") { Task { await client.feedback(turnId: r.provenance.turnId, helpful: true) } }
                Button("Not helpful") { Task { await client.feedback(turnId: r.provenance.turnId, helpful: false) } }
                Spacer()
                Text(r.provenance.sourcePath).font(.caption2).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle)
              }
            }
          }
          .frame(maxHeight: 240)
        }
      } else {
        List(decisions, selection: $selection) { d in
          VStack(alignment: .leading, spacing: 2) {
            HStack {
              Text(d.method.uppercased()).font(.caption2).bold()
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .background(Color.green.opacity(0.15))
                .cornerRadius(3)
              Text(String(format: "conf %.2f", d.confidence)).font(.caption.monospaced()).foregroundStyle(.secondary)
              Text(d.session.harness).font(.caption).foregroundStyle(.secondary)
            }
            Text(d.conclusion.content).font(.body).lineLimit(3)
            if let q = d.question { Text("Q: \(q.content)").font(.caption).italic().lineLimit(2) }
            if !d.rationale.isEmpty {
              Text("Rationale: " + d.rationale.map { $0.content }.joined(separator: " ")).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
          }
          .tag(d.id)
        }
      }
    }
    .padding(8)
    .frame(width: 600, height: 580)
    .task {
      await client.refreshHealth()
    }
  }

  var selectedResult: SearchResult? { results.first { $0.id == selection } }

  private func copyToClipboard(_ text: String, notice: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
    copiedNotice = notice
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
      if copiedNotice == notice { copiedNotice = nil }
    }
  }

  private func formatMarkdownEvidence(_ r: SearchResult) -> String {
    var lines: [String] = []
    lines.append("> ### Evidence from \(r.provenance.harness) (Session \(r.provenance.shortSession))")
    for t in r.context {
      lines.append("> **\(t.role)**: \(t.content)")
      lines.append(">")
    }
    lines.append("> *Source*: `\(r.provenance.turnId)` at \(r.provenance.timestamp)")
    return lines.joined(separator: "\n")
  }

  private func formattedNumber(_ n: Int) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    return f.string(from: NSNumber(value: n)) ?? String(n)
  }

  func run() {
    let q = query.trimmingCharacters(in: .whitespaces)
    guard !q.isEmpty else { return }
    searching = true
    Task {
      defer { searching = false }
      do {
        if mode == 0 {
          results = try await client.search(q, harness: harness).results
        } else {
          decisions = try await client.decide(q).decisions
        }
      } catch {
        client.lastError = error.localizedDescription
      }
    }
  }
}
