const test = require('node:test');
const assert = require('node:assert');
const { collectLimits } = require('../limits');

const NOW = Date.parse('2026-11-17T06:00:00Z');
const at = (iso) => iso;
const R5 = Math.floor(NOW / 1000) + 3 * 3600;
const RW = Math.floor(NOW / 1000) + 3 * 86400;

test('antigravity quota becomes used% rows, newest session wins', () => {
    const g = collectLimits({
        'a:1': { source: 'antigravity', _receivedAt: at('2026-11-17T05:00:00Z'),
                 quota: { 'gemini-5h': { remaining_fraction: 0.9, reset_time: '2026-11-17T09:00:00Z' } } },
        'a:2': { source: 'terminal', _receivedAt: at('2026-11-17T05:30:00Z'),
                 quota: { 'gemini-5h': { remaining_fraction: 0.75, reset_time: '2026-11-17T09:00:00Z' },
                          'gemini-weekly': { remaining_fraction: 0.5, reset_time: '2026-11-20T00:00:00Z' } } },
    }, NOW);
    assert.equal(g.length, 1);
    assert.equal(g[0].provider, 'antigravity');
    assert.deepEqual(g[0].rows.map(r => [r.label, r.usedPct]), [['Gemini 5h', 25], ['Gemini Week', 50]]);
});

test('claude rate_limits and codex primary/secondary are recognised', () => {
    const g = collectLimits({
        'c:1': { source: 'claudecode', _receivedAt: '2026-11-17T05:59:00Z',
                 rate_limits: { five_hour: { used_percentage: 12.5, resets_at: R5 },
                                seven_day: { used_percentage: 40, resets_at: RW } } },
        'x:1': { source: 'codex', _receivedAt: '2026-11-17T05:59:00Z',
                 rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: R5 },
                                secondary: { used_percent: 60, window_minutes: 10080, resets_at: RW } } },
    }, NOW);
    const by = Object.fromEntries(g.map(x => [x.provider, x.rows.map(r => [r.window, r.usedPct])]));
    assert.deepEqual(by.claude, [['5h', 12.5], ['week', 40]]);
    assert.deepEqual(by.codex, [['5h', 10], ['week', 60]]);
});

test('rolled-over window resets to 0 and stale payloads are dropped', () => {
    const g = collectLimits({
        'a:1': { source: 'antigravity', _receivedAt: '2026-11-17T05:00:00Z',
                 quota: { '3p-5h': { remaining_fraction: 0.1, reset_time: '2026-11-17T04:00:00Z' } } },
        'old': { source: 'claude', _receivedAt: '2026-11-10T00:00:00Z',
                 rate_limits: { five_hour: { used_percentage: 99 } } },
    }, NOW);
    assert.equal(g.length, 1);
    assert.deepEqual(g[0].rows[0], { key: '3p-5h', label: '3P 5h', window: '5h', usedPct: 0, resetAt: null });
});

test('providers without limit data are omitted', () => {
    assert.deepEqual(collectLimits({ 'g:1': { source: 'grok', _receivedAt: '2026-11-17T05:59:00Z' } }, NOW), []);
});
