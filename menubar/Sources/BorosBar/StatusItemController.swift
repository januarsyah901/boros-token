import AppKit
import SwiftUI

/// Hosting view that lets clicks fall through to the NSStatusBarButton underneath.
final class PassthroughHostingView<Content: View>: NSHostingView<Content> {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

@MainActor
final class StatusItemController: NSObject, NSMenuDelegate {
    private let model: BorosModel
    private let statusItem: NSStatusItem
    private let menu = NSMenu()
    private var rateItems: [NSMenuItem] = []
    private var todayItem: NSMenuItem!
    private var serverOn: NSMenuItem!
    private var serverOff: NSMenuItem!

    /// Project that owns the server scripts. Override with: defaults write dev.local.borosbar projectDir <path>
    private var projectDir: String {
        UserDefaults.standard.string(forKey: "projectDir")
            ?? NSHomeDirectory() + "/Downloads/code/project/boros-token"
    }
    private let rates: [(String, TimeInterval)] = [("Fast (1 s)", 1), ("Normal (2 s)", 2), ("Relaxed (5 s)", 5)]

    init(model: BorosModel) {
        self.model = model
        statusItem = NSStatusBar.system.statusItem(withLength: Theme.statusWidth)
        super.init()
        if let button = statusItem.button {
            let host = PassthroughHostingView(rootView: MeterView(model: model))
            host.sizingOptions = []
            host.frame = button.bounds
            host.autoresizingMask = [.width, .height]
            button.addSubview(host)
            button.setAccessibilityLabel("Boros token usage")
        }
        menu.delegate = self
        menu.autoenablesItems = false
        buildMenu()
        statusItem.menu = menu
    }

    private func hosted<V: View>(_ view: V, height: CGFloat) -> NSMenuItem {
        let host = NSHostingView(rootView: view)
        host.sizingOptions = []
        host.frame = NSRect(x: 0, y: 0, width: Theme.menuWidth, height: height)
        let item = NSMenuItem()
        item.view = host
        return item
    }

    private func action(_ title: String, _ sel: Selector, key: String = "") -> NSMenuItem {
        let it = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        it.target = self
        return it
    }

    private func buildMenu() {
        menu.addItem(hosted(HeaderView(model: model), height: HeaderView.height))
        menu.addItem(.separator())
        todayItem = hosted(TodayListView(model: model), height: TodayListView.height(rows: 1))
        menu.addItem(todayItem)
        menu.addItem(.separator())

        menu.addItem(action("Open Web Dashboard", #selector(openDashboard)))
        serverOn = action("Turn Server On", #selector(serverStart))
        serverOff = action("Turn Server Off", #selector(serverStop))
        menu.addItem(serverOn)
        menu.addItem(serverOff)
        menu.addItem(action("Restart Server", #selector(serverRestart)))

        let rateRoot = NSMenuItem(title: "Update Rate", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for (title, secs) in rates {
            let it = action(title, #selector(setRate(_:)))
            it.representedObject = secs
            sub.addItem(it)
            rateItems.append(it)
        }
        rateRoot.submenu = sub
        menu.addItem(rateRoot)

        menu.addItem(.separator())
        menu.addItem(action("Quit BorosBar", #selector(quit), key: "q"))
    }

    // MARK: NSMenuDelegate — expensive work only while open

    func menuWillOpen(_ menu: NSMenu) {
        for it in rateItems { it.state = (it.representedObject as? TimeInterval) == model.interval ? .on : .off }
        serverOn.isHidden = model.online
        serverOff.isHidden = !model.online
        // Size the list from the last known data, then refresh it.
        let rows = min(model.today.count, TodayListView.maxRows)
        todayItem.view?.frame.size.height = TodayListView.height(rows: rows)
        model.setMenuOpen(true)
    }

    func menuDidClose(_ menu: NSMenu) { model.setMenuOpen(false) }

    // MARK: Actions

    @objc private func setRate(_ s: NSMenuItem) {
        if let v = s.representedObject as? TimeInterval { model.setInterval(v) }
    }
    @objc private func openDashboard() { NSWorkspace.shared.open(URL(string: BorosModel.baseURL)!) }
    @objc private func serverStart() { runScript("server_start.sh") }
    @objc private func serverStop() { runScript("server_stop.sh") }
    @objc private func serverRestart() { runScript("server_restart.sh") }
    @objc private func quit() { NSApp.terminate(nil) }

    private func runScript(_ name: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["\(projectDir)/scripts/\(name)"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak model] _ in Task { @MainActor in await model?.poll() } }
        try? p.run()
    }
}
