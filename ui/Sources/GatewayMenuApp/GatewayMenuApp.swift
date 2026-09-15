import SwiftUI
import AppKit
import GatewayMenuCore

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    SearchPanelController.shared.setup()
  }
}

@main
struct GatewayMenuApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
  @StateObject private var client = GatewayClient()

  var body: some Scene {
    Settings {
      Form {
        TextField("Gateway port", value: portBinding, formatter: NumberFormatter())
        Text("Restart the app to apply. Default 3000 (serve --port).")
          .font(.caption).foregroundStyle(.secondary)
        Text("Global hotkey: ⌘⇧K toggles the search panel from anywhere.")
          .font(.caption).foregroundStyle(.secondary)
        if let h = client.health {
          Text("\(h.docCount) turns · \(h.sources.map { "\($0.harness) \($0.sessions)" }.joined(separator: " · "))")
            .font(.caption)
        }
        if let err = client.lastError { Text(err).foregroundStyle(.red).font(.caption) }
      }
      .padding()
      .frame(width: 360)
      .task { await client.refreshHealth() }
    }
  }

  private var portBinding: Binding<Int> {
    Binding(
      get: {
        let p = UserDefaults.standard.integer(forKey: "gatewayPort")
        return p == 0 ? 3000 : p
      },
      set: { UserDefaults.standard.set($0, forKey: "gatewayPort") }
    )
  }
}
