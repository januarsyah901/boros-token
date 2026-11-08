# BorosBar

Native macOS menu bar app for [Boros Token](../../project/boros-token). Replaces the SwiftBar plugin.

- Status item (fixed width): state dot + `↑ input  ↓ output` token totals, EMA-smoothed.
- Dropdown (native NSMenu): agent/model/state, live token-rate graph (5 min), context gauge,
  per-agent usage and cost for today, dashboard link, server on/off/restart, update rate, quit.
- Accents: orange (input) and red (output); text uses `.primary`/`.secondary`.
- Data: `GET :4000/api/state` is polled continuously (cheap). `/api/stats/daily` is fetched only when the menu opens.
- Server scripts are run from `~/Downloads/code/project/boros-token/scripts`
  (override: `defaults write dev.local.borosbar projectDir <path>`).

## Build / run
    ./scripts/build-app.sh && open build/BorosBar.app

swiftc + ad-hoc codesign, macOS 14+, LSUIElement (no Dock icon), no entitlements.
Disable the SwiftBar plugin to avoid two menu bar items.
