import SwiftUI

// MARK: Status item content

struct MeterView: View {
    let model: BorosModel

    var body: some View {
        HStack(spacing: 5) {
            if model.online {
                HStack(spacing: 3) {
                    Text("↑").foregroundStyle(Theme.input)
                    num(model.displayIn)
                    Text("↓").foregroundStyle(Theme.output)
                    num(model.displayOut)
                }
            } else {
                Text("offline").foregroundStyle(.secondary)
            }
        }
        .font(.system(size: 11, weight: .medium))
        .lineLimit(1)
        .fixedSize()
        .frame(width: Theme.statusWidth, height: 22)
    }

    private func num(_ v: Double) -> some View {
        Text(Fmt.k(v.rounded()))
            .monospacedDigit()
            .foregroundStyle(.primary)
            .fixedSize()
    }
}

// MARK: Sparkline (time-positioned, curve-smoothed, gradient area)

struct SparklineView: View {
    let samples: [Sample]

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { tl in
            Canvas { ctx, size in draw(ctx, size, now: tl.date) }
        }
    }

    private func draw(_ ctx: GraphicsContext, _ size: CGSize, now: Date) {
        let window = BorosModel.window
        let start = now.addingTimeInterval(-window)
        let vis = samples.filter { $0.time >= start.addingTimeInterval(-10) }

        var base = Path()
        base.move(to: CGPoint(x: 0, y: size.height - 0.5))
        base.addLine(to: CGPoint(x: size.width, y: size.height - 0.5))
        ctx.stroke(base, with: .color(.primary.opacity(0.15)), lineWidth: 0.5)
        guard vis.count > 1 else { return }

        // Floor on the Y scale so idle noise doesn't look like a spike.
        let peak = max(200.0, vis.map { max($0.inRate, $0.outRate) }.max() ?? 0) * 1.15
        func pts(_ f: (Sample) -> Double) -> [CGPoint] {
            vis.map {
                CGPoint(x: CGFloat($0.time.timeIntervalSince(start) / window) * size.width,
                        y: size.height - CGFloat(f($0) / peak) * size.height)
            }
        }
        layer(ctx, size, pts(\.outRate), Theme.output)
        layer(ctx, size, pts(\.inRate), Theme.input)
    }

    private func layer(_ ctx: GraphicsContext, _ size: CGSize, _ p: [CGPoint], _ color: Color) {
        guard let first = p.first, let last = p.last else { return }
        var line = Path()
        line.move(to: first)
        for i in 1..<p.count {
            let mid = CGPoint(x: (p[i-1].x + p[i].x) / 2, y: (p[i-1].y + p[i].y) / 2)
            line.addQuadCurve(to: mid, control: p[i-1])
        }
        line.addLine(to: last)
        var area = line
        area.addLine(to: CGPoint(x: last.x, y: size.height))
        area.addLine(to: CGPoint(x: first.x, y: size.height))
        area.closeSubpath()
        ctx.fill(area, with: .linearGradient(
            Gradient(colors: [color.opacity(0.45), color.opacity(0.02)]),
            startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)))
        ctx.stroke(line, with: .color(color), style: StrokeStyle(lineWidth: 1.3, lineCap: .round, lineJoin: .round))
    }
}

// MARK: Dropdown header

struct HeaderView: View {
    static let height: CGFloat = 206
    let model: BorosModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if model.online && model.hasState {
                HStack(alignment: .firstTextBaseline) {
                    Text(model.agentLabel).font(.system(size: 13, weight: .semibold))
                    Text(model.modelName).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(model.agentState.uppercased())
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(model.agentState == "working" ? Theme.input : .secondary)
                }
                HStack {
                    big("arrow.up", model.hIn, Theme.input)
                    Spacer()
                    big("arrow.down", model.hOut, Theme.output)
                }
                SparklineView(samples: model.hHistory)
                    .frame(height: 56)
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                HStack {
                    Text("5 min ago"); Spacer()
                    Text(Fmt.rate(model.hRate)).monospacedDigit(); Spacer()
                    Text("now")
                }
                .font(.system(size: 9)).foregroundStyle(.secondary)
                gauge
            } else {
                VStack(spacing: 6) {
                    Image(systemName: model.online ? "moon.zzz" : "bolt.slash")
                        .font(.system(size: 22)).foregroundStyle(.secondary)
                    Text(model.online ? "No active agent session yet" : "Server offline (:4000)")
                        .font(.system(size: 12, weight: .medium))
                    Text(model.online ? "Waiting for the first token event" : "Use the menu below to turn it on")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(width: Theme.menuWidth, height: Self.height, alignment: .topLeading)
    }

    private func big(_ symbol: String, _ v: Double, _ tint: Color) -> some View {
        HStack(spacing: 4) {
            Image(systemName: symbol).font(.system(size: 10, weight: .bold)).foregroundStyle(tint)
            Text(Int(v.rounded()).formatted())
                .font(.system(size: 14, weight: .semibold).monospacedDigit())
                .contentTransition(.numericText())
                .animation(.smooth(duration: 0.3), value: Int(v))
        }
    }

    private var gauge: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text("Context").foregroundStyle(.secondary)
                Spacer()
                Text(model.contextSize > 0
                     ? "\(String(format: "%.1f", model.percent))% of \(Fmt.k(model.contextSize))"
                     : "\(String(format: "%.1f", model.percent))%")
                    .monospacedDigit()
            }
            .font(.system(size: 10))
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(.primary.opacity(0.12))
                    Capsule().fill(Theme.input)
                        .frame(width: g.size.width * min(max(model.percent / 100, 0), 1))
                        .animation(.smooth(duration: 0.4), value: model.percent)
                }
            }
            .frame(height: 4)
            if model.cacheRead > 0 {
                Text("Cache read \(model.cacheRead.formatted())")
                    .font(.system(size: 9)).foregroundStyle(.secondary).monospacedDigit()
            }
        }
    }
}

// MARK: Today per-agent list

struct TodayListView: View {
    static let maxRows = 4
    static func height(rows: Int) -> CGFloat { 30 + CGFloat(max(rows, 1)) * 20 + 6 }
    let model: BorosModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("TODAY").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                Spacer()
                Text(Fmt.cost(model.todayCost))
                    .font(.system(size: 11, weight: .semibold).monospacedDigit())
            }
            if model.today.isEmpty {
                Text("No usage recorded today").font(.system(size: 11)).foregroundStyle(.secondary)
                    .frame(height: 20, alignment: .leading)
            } else {
                ForEach(model.today.prefix(Self.maxRows)) { r in
                    HStack {
                        Text(AgentNames.label(r.agent)).font(.system(size: 12)).lineLimit(1)
                        Spacer()
                        Text(Fmt.k(r.tokens)).font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
                        Text(Fmt.cost(r.cost)).font(.system(size: 11).monospacedDigit())
                            .frame(width: 52, alignment: .trailing)
                    }
                    .frame(height: 20)
                }
            }
        }
        .padding(.horizontal, 14).padding(.top, 8)
        .frame(width: Theme.menuWidth, height: Self.height(rows: min(model.today.count, Self.maxRows)), alignment: .topLeading)
    }
}
