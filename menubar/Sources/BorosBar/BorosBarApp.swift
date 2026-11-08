import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let model = BorosModel()
    private var controller: StatusItemController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        controller = StatusItemController(model: model)
        model.start()
    }
}

@main
struct BorosBarApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
