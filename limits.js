/**
 * Collect 5-hour / weekly usage limits per provider from the latest session payloads.
 * Output row: { key, label, window: '5h'|'week', usedPct (0-100), resetAt (ISO|null) }.
 * No monthly window: no provider reports one.
 */

const PROVIDER_OF = {
    claude: 'claude', claudecode: 'claude',
    codex: 'codex',
    grok: 'grok',
    opencode: 'opencode',
    terminal: 'antigravity', agy: 'antigravity', antigravity: 'antigravity', code: 'antigravity', sdk: 'antigravity',
};

const MAX_AGE_MS = 24 * 3600 * 1000; // ignore payloads older than a day

function clampPct(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
}

function toIso(v) {
    if (v == null || v === '') return null;
    const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Antigravity: quota { '<family>-5h': { remaining_fraction, reset_time }, '<family>-weekly': ... }
function fromQuota(quota) {
    const out = [];
    for (const [k, v] of Object.entries(quota || {})) {
        const m = /^(.+)-(5h|weekly)$/.exec(k);
        if (!m || !v || typeof v !== 'object') continue;
        const used = clampPct((1 - Number(v.remaining_fraction)) * 100);
        if (used == null) continue;
        const family = m[1] === '3p' ? '3P' : m[1].charAt(0).toUpperCase() + m[1].slice(1);
        const win = m[2] === '5h' ? '5h' : 'week';
        out.push({ key: k, label: `${family} ${win === '5h' ? '5h' : 'Week'}`, window: win,
                   usedPct: used, resetAt: toIso(v.reset_time) });
    }
    return out;
}

// Claude Code statusline: rate_limits { five_hour|seven_day: { used_percentage, resets_at } }
// Codex: rate_limits { primary|secondary: { used_percent, window_minutes, resets_at } }
function fromRateLimits(rl) {
    const out = [];
    if (!rl || typeof rl !== 'object') return out;
    const add = (key, win, src) => {
        if (!src || typeof src !== 'object') return;
        const used = clampPct(src.used_percentage ?? src.used_percent);
        if (used == null) return;
        out.push({ key, label: win === '5h' ? '5h' : 'Week', window: win,
                   usedPct: used, resetAt: toIso(src.resets_at ?? src.reset_at ?? src.reset_time) });
    };
    add('five_hour', '5h', rl.five_hour);
    add('seven_day', 'week', rl.seven_day);
    for (const slot of ['primary', 'secondary']) {
        const s = rl[slot];
        if (!s) continue;
        const mins = Number(s.window_minutes);
        add(slot, mins >= 24 * 60 ? 'week' : '5h', s);
    }
    return out;
}

function extract(payload) {
    return [...fromQuota(payload.quota), ...fromRateLimits(payload.rate_limits)];
}

/** Window already rolled over -> usage is back to 0 and the reset time is no longer meaningful. */
function applyRollover(row, now) {
    if (row.resetAt && new Date(row.resetAt).getTime() <= now) return { ...row, usedPct: 0, resetAt: null };
    return row;
}

function collectLimits(latestStates, now = Date.now()) {
    // provider -> key -> { row, received }
    const best = {};
    for (const p of Object.values(latestStates || {})) {
        if (!p) continue;
        const provider = PROVIDER_OF[String(p.source || p.agent || '').toLowerCase()];
        const received = new Date(p._receivedAt).getTime();
        if (!provider || !Number.isFinite(received) || now - received > MAX_AGE_MS) continue;
        for (const row of extract(p)) {
            const slot = (best[provider] ||= {});
            if (!slot[row.key] || received > slot[row.key].received) slot[row.key] = { row, received };
        }
    }
    return Object.entries(best).map(([provider, slot]) => ({
        provider,
        rows: Object.values(slot)
            .map(s => applyRollover(s.row, now))
            .sort((a, b) => (a.window === b.window ? a.label.localeCompare(b.label) : a.window === '5h' ? -1 : 1)),
    })).filter(g => g.rows.length);
}

module.exports = { collectLimits, extract, applyRollover };
