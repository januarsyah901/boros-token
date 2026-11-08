import SwiftUI
import AppKit

enum Theme {
    /// Only two accents: orange (input) / red (output), both readable on light and dark menus. Everything else uses .primary / .secondary.
    static let input  = Color(red: 1.00, green: 0.60, blue: 0.10)
    static let output = Color(red: 0.95, green: 0.27, blue: 0.30)
    static let menuWidth: CGFloat = 288
    /// Fixed width sized to the widest possible content ("↑ 999k ↓ 999k") + 6 pt padding per side,
    /// so it sits like other menu bar items and never jitters when digits change.
    static let statusWidth: CGFloat = {
        func w(_ s: String) -> CGFloat {
            let f = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
            return ceil((s as NSString).size(withAttributes: [.font: f]).width)
        }
        return w("↑") + w("999k") + w("↓") + w("999k") + 3 * 3 + 12
    }()
}

enum Fmt {
    /// 3 significant digits: 152k, 15.2k, 1.52k, 1.52M.
    static func k(_ v: Double) -> String {
        let (x, u): (Double, String) = v >= 1_000_000 ? (v / 1_000_000, "M") : v >= 1_000 ? (v / 1_000, "k") : (v, "")
        if u.isEmpty { return "\(Int(v))" }
        var s = x >= 100 ? String(format: "%.0f", x) : x >= 10 ? String(format: "%.1f", x) : String(format: "%.2f", x)
        if s.contains(".") { while s.hasSuffix("0") { s.removeLast() }; if s.hasSuffix(".") { s.removeLast() } }
        return s + u
    }
    static func rate(_ v: Double) -> String { v < 1 ? "0 tok/s" : "\(k(v)) tok/s" }
    static func cost(_ v: Double) -> String { v < 0.01 && v > 0 ? "<$0.01" : String(format: "$%.2f", v) }
}

enum AgentNames {
    static let labels: [String: String] = [
        "terminal": "Antigravity CLI", "agy": "Agy CLI", "antigravity": "Antigravity",
        "code": "Antigravity IDE", "codex": "Codex", "opencode": "OpenCode",
        "claudecode": "Claude Code", "claude": "Claude Code", "grok": "Grok",
    ]
    static func label(_ raw: String) -> String {
        let key = raw.lowercased()
        return labels[key] ?? (key.isEmpty ? "Agent" : key.capitalized)
    }
}
