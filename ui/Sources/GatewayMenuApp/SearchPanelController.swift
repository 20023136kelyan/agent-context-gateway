import AppKit
import SwiftUI
import GatewayMenuCore

/// Spotlight-style floating search panel controller for Context Gateway.
/// Summoned via global shortcut ⌘⇧K or menu bar icon.
@MainActor
final class SearchPanelController: NSObject, NSWindowDelegate {
  static let shared = SearchPanelController()

  private var panel: NSPanel?
  private var statusItem: NSStatusItem?
  private var globalMonitor: Any?
  private var localMonitor: Any?
  private let client = GatewayClient()

  override init() {
    super.init()
  }

  func setup() {
    setupStatusItem()
    setupPanel()
    setupHotKey()
  }

  private func setupStatusItem() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = statusItem?.button {
      button.image = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: "Context Gateway")
      button.action = #selector(togglePanel)
      button.target = self
    }
  }

  private func setupPanel() {
    let p = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 600, height: 480),
      styleMask: [.titled, .closable, .fullSizeContentView, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    p.titleVisibility = .hidden
    p.titlebarAppearsTransparent = true
    p.isFloatingPanel = true
    p.level = .floating
    p.animationBehavior = .utilityWindow
    p.isMovableByWindowBackground = true
    p.backgroundColor = .windowBackgroundColor
    p.delegate = self

    let searchView = SearchView(client: client)
    p.contentView = NSHostingView(rootView: searchView)
    self.panel = p
  }

  private func setupHotKey() {
    // ⌘⇧K keycode = 40 (ANSI K)
    let mask: NSEvent.ModifierFlags = [.command, .shift]

    // Local monitor (when our app has focus)
    localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      if event.keyCode == 40 && event.modifierFlags.intersection(.deviceIndependentFlagsMask) == mask {
        self?.togglePanel()
        return nil
      }
      if event.keyCode == 53 { // ESC key
        if self?.panel?.isVisible == true {
          self?.hidePanel()
          return nil
        }
      }
      return event
    }

    // Global monitor (when any other app has focus)
    globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
      if event.keyCode == 40 && event.modifierFlags.intersection(.deviceIndependentFlagsMask) == mask {
        DispatchQueue.main.async {
          self?.togglePanel()
        }
      }
    }
  }

  @objc func togglePanel() {
    guard let panel = panel else { return }
    if panel.isVisible {
      hidePanel()
    } else {
      showPanel()
    }
  }

  func showPanel() {
    guard let panel = panel else { return }
    if let screen = NSScreen.main {
      let screenRect = screen.visibleFrame
      let x = screenRect.midX - panel.frame.width / 2
      let y = screenRect.maxY - panel.frame.height - 100 // Spotlight placement near top-center
      panel.setFrameOrigin(NSPoint(x: x, y: y))
    }
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
  }

  func hidePanel() {
    panel?.orderOut(nil)
  }

  func windowDidResignKey(_ notification: Notification) {
    // Optional auto-hide on click-away
    hidePanel()
  }

  deinit {
    if let gm = globalMonitor { NSEvent.removeMonitor(gm) }
    if let lm = localMonitor { NSEvent.removeMonitor(lm) }
  }
}
