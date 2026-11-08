import Foundation
import Observation

struct Sample: Identifiable {
    let id = UUID()
    let time: Date
    let inRate: Double
    let outRate: Double
}

struct AgentDay: Identifiable {
    var id: String { agent }
    let agent: String
    let tokens: Double
    let cost: Double
}

@MainActor
@Observable
final class BorosModel {
    static let window: TimeInterval = 300
    static let baseURL = "http://localhost:4000"

    // Raw targets
    var online = false
    var hasState = false
    var agentRaw = ""
    var modelName = ""
    var agentState = "idle"
    var totalIn = 0.0
    var totalOut = 0.0
    var percent = 0.0
    var contextSize = 0.0
    var cacheRead = 0.0

    // Smoothed values shown in UI
    var displayIn = 0.0
    var displayOut = 0.0
    var displayRate = 0.0

    var history: [Sample] = []

    // Header snapshot: only refreshed while the menu is open, so the hidden dropdown costs nothing.
    var hIn = 0.0
    var hOut = 0.0
    var hRate = 0.0
    var hHistory: [Sample] = []
    @ObservationIgnored var menuOpen = false
    var today: [AgentDay] = []
    var interval: TimeInterval

    @ObservationIgnored private var pollTimer: Timer?
    @ObservationIgnored private var smoothTimer: Timer?
    @ObservationIgnored private var inFlight = false
    @ObservationIgnored private var prev: (key: String, time: Date, inT: Double, outT: Double)?
    @ObservationIgnored private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 1.5
        return URLSession(configuration: c)
    }()

    var todayCost: Double { today.reduce(0) { $0 + $1.cost } }
    var agentLabel: String { AgentNames.label(agentRaw) }

    init() {
        let saved = UserDefaults.standard.double(forKey: "interval")
        interval = saved > 0 ? saved : 2
    }

    // MARK: Cheap data — sampled continuously

    func start() {
        schedulePoll()
        Task { await fetchToday() }
    }

    func setInterval(_ s: TimeInterval) {
        interval = s
        UserDefaults.standard.set(s, forKey: "interval")
        schedulePoll()
    }

    private func schedulePoll() {
        pollTimer?.invalidate()
        let t = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.poll() }
        }
        t.tolerance = interval * 0.2
        RunLoop.main.add(t, forMode: .common)   // keep ticking while the menu is open
        pollTimer = t
        Task { await poll() }
    }

    private func getJSON(_ path: String) async -> Any? {
        guard let url = URL(string: Self.baseURL + path),
              let (data, resp) = try? await session.data(from: url),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    func poll() async {
        guard !inFlight else { return }
        inFlight = true
        defer { inFlight = false }

        guard let root = await getJSON("/api/state") as? [String: Any] else {
            online = false; hasState = false; displayRate = 0; prev = nil
            return
        }
        online = true
        guard let s = root["latestState"] as? [String: Any] else { hasState = false; return }
        hasState = true

        let cw = s["context_window"] as? [String: Any] ?? [:]
        let usage = cw["current_usage"] as? [String: Any] ?? [:]
        let tin = (cw["total_input_tokens"] as? NSNumber)?.doubleValue ?? 0
        let tout = (cw["total_output_tokens"] as? NSNumber)?.doubleValue ?? 0
        percent = (cw["used_percentage"] as? NSNumber)?.doubleValue ?? 0
        contextSize = (cw["context_window_size"] as? NSNumber)?.doubleValue ?? 0
        cacheRead = (usage["cache_read_input_tokens"] as? NSNumber)?.doubleValue ?? 0
        agentState = ((s["agent_state"] as? String) ?? "idle").lowercased()
        agentRaw = ((s["source"] ?? s["agent"] ?? s["product"]) as? String) ?? ""
        if let m = s["model"] as? [String: Any] {
            modelName = (m["display_name"] as? String) ?? (m["id"] as? String) ?? ""
        } else {
            modelName = (s["model"] as? String) ?? ""
        }
        totalIn = tin
        totalOut = tout

        // Rate from the delta between samples (real timestamps); reset on session switch/decrease.
        let now = Date()
        let key = "\(agentRaw)|\((s["session_id"] ?? s["conversation_id"]) as? String ?? "")"
        if let p = prev, p.key == key, tin >= p.inT, tout >= p.outT {
            let dt = max(now.timeIntervalSince(p.time), 0.1)
            history.append(Sample(time: now, inRate: (tin - p.inT) / dt, outRate: (tout - p.outT) / dt))
        } else if prev != nil {
            history.append(Sample(time: now, inRate: 0, outRate: 0))
        }
        prev = (key, now, tin, tout)
        let cutoff = now.addingTimeInterval(-Self.window - 10)
        history.removeAll { $0.time < cutoff }
        if let last = history.last { displayRate += (last.inRate + last.outRate - displayRate) * 0.5 }

        if menuOpen { syncHeader() }
        startSmoothing()
    }

    private func syncHeader() {
        hIn = displayIn; hOut = displayOut; hRate = displayRate; hHistory = history
    }

    // EMA on displayed numbers; the timer stops itself once converged (idle = no timer).
    private func startSmoothing() {
        guard smoothTimer == nil else { return }
        let t = Timer(timeInterval: 0.2, repeats: true) { [weak self] timer in
            Task { @MainActor in
                guard let self else { timer.invalidate(); return }
                self.displayIn += (self.totalIn - self.displayIn) * 0.5
                self.displayOut += (self.totalOut - self.displayOut) * 0.5
                if self.menuOpen { self.syncHeader() }
                if abs(self.totalIn - self.displayIn) < 0.5, abs(self.totalOut - self.displayOut) < 0.5 {
                    self.displayIn = self.totalIn
                    self.displayOut = self.totalOut
                    if self.menuOpen { self.syncHeader() }
                    timer.invalidate()
                    self.smoothTimer = nil
                }
            }
        }
        RunLoop.main.add(t, forMode: .common)
        smoothTimer = t
    }

    // MARK: Expensive data — only while the menu is open

    func setMenuOpen(_ open: Bool) {
        menuOpen = open
        if open { syncHeader(); Task { await fetchToday() } }
    }

    func fetchToday() async {
        guard let rows = await getJSON("/api/stats/daily?days=2") as? [[String: Any]] else { return }
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.timeZone = TimeZone(identifier: "UTC")   // server groups by UTC date
        let day = fmt.string(from: Date())
        today = rows.filter { ($0["date"] as? String) == day }.map {
            let tok = (($0["input_tokens"] as? NSNumber)?.doubleValue ?? 0)
                    + (($0["output_tokens"] as? NSNumber)?.doubleValue ?? 0)
            return AgentDay(agent: ($0["agent"] as? String) ?? "?",
                            tokens: tok,
                            cost: ($0["total_cost"] as? NSNumber)?.doubleValue ?? 0)
        }.sorted { $0.cost > $1.cost || ($0.cost == $1.cost && $0.tokens > $1.tokens) }
    }
}
