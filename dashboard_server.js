const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = 4000;
const DB_FILE = path.join(__dirname, 'history_log.json');
const CODEX_DB = path.join(process.env.HOME || '', '.codex', 'logs_2.sqlite');
const OPENCODE_DB = path.join(process.env.HOME || '', '.local', 'share', 'opencode', 'opencode.db');

// Latest state keyed by source/session so multiple agents can coexist.
let latestStates = {};
// Single latestState: the most recently received state (for backwards compat)
let latestState = null;
let history = [];
const clients = [];
const pollState = {
    codexLastLogId: 0,
    opencodeLastTime: 0
};

// Load state from disk on startup
function loadStateFromDisk() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const raw = fs.readFileSync(DB_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            latestState = parsed.latestState || null;
            latestStates = parsed.latestStates || {};
            history = parsed.history || [];
            console.log(`[Dashboard Server] Loaded history from disk. Total events: ${history.length}`);
        }
    } catch (e) {
        console.error('Error loading history from disk:', e);
    }
}

function normalizeSource(payload) {
    const raw = payload?.agent || payload?.source || payload?.product || payload?.client || 'unknown';
    return String(raw).trim().toLowerCase() || 'unknown';
}

function getDisplaySource(source) {
    const map = {
        codex: 'Codex',
        opencode: 'OpenCode',
        agy: 'Agy',
        terminal: 'Antigravity CLI',
        antigravity: 'Antigravity',
        code: 'Antigravity IDE',
        sdk: 'Antigravity SDK'
    };
    return map[source] || source;
}

function processPayload(payload) {
    const source = normalizeSource(payload);

    payload._receivedAt = new Date().toISOString();
    payload.source = source;
    payload.agent = payload.agent || source;

    const sessionKey = `${source}:${payload.session_id || payload.conversation_id || 'global'}`;
    latestStates[sessionKey] = payload;
    latestState = payload;

    addToHistory(payload);
    saveStateToDisk();
    broadcast();

    return { source, displaySource: getDisplaySource(source), historyLength: history.length };
}

// Save state to disk (debounced to reduce I/O)
let saveTimer = null;
function saveStateToDisk() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            const data = JSON.stringify({ latestState, latestStates, history }, null, 2);
            fs.writeFileSync(DB_FILE, data, 'utf8');
        } catch (e) {
            console.error('Error saving history to disk:', e);
        }
    }, 500);
}

// Load state
loadStateFromDisk();

// Compute the "best" latestState for display:
// Pick the most recently received state that has meaningful tokens,
// OR the absolute most recent if all are idle.
function computeBestState() {
    const all = Object.values(latestStates);
    if (all.length === 0) return latestState;

    // Prefer states with agent_state=working
    const working = all.filter(s => s.agent_state === 'working');
    if (working.length > 0) {
        return working.sort((a, b) => new Date(b._receivedAt) - new Date(a._receivedAt))[0];
    }

    // Prefer states with current tokens > 0
    const withTokens = all.filter(s => {
        const cu = s.context_window?.current_usage;
        return cu && (cu.input_tokens > 0 || cu.output_tokens > 0);
    });
    if (withTokens.length > 0) {
        return withTokens.sort((a, b) => new Date(b._receivedAt) - new Date(a._receivedAt))[0];
    }

    // Fall back to most recently received
    return all.sort((a, b) => new Date(b._receivedAt) - new Date(a._receivedAt))[0] || latestState;
}

// Broadcast to all connected SSE clients
function broadcast() {
    const best = computeBestState();
    const eventData = JSON.stringify({ latestState: best, latestStates, history });
    const deadClients = [];
    clients.forEach((client, i) => {
        try {
            client.write(`data: ${eventData}\n\n`);
        } catch (e) {
            deadClients.push(i);
        }
    });
    for (let i = deadClients.length - 1; i >= 0; i--) {
        clients.splice(deadClients[i], 1);
    }
}

// Add event to history
// Session-aware deduplication rules:
//  - Match by source + session_id to prevent cross-agent phantom entries
//  - If state is 'working': UPDATE the session's most recent event in place
//  - If transitioned from 'working' to done: UPDATE to finalize
//  - If idle→idle with no token change for same session: skip
//  - Extra: if idle and exact same tokens exist in history (stale reconnect): update in-place
//  - Otherwise: push new event
function addToHistory(state) {
    if (!state || !state.context_window) return;

    const timestamp = new Date().toISOString();
    const currentInput = state.context_window.current_usage?.input_tokens || 0;
    const currentOutput = state.context_window.current_usage?.output_tokens || 0;
    const currentCacheRead = state.context_window.current_usage?.cache_read_input_tokens || 0;
    const source = normalizeSource(state);
    const agentState = state.agent_state || 'idle';
    const modelName = state.model?.display_name || state.model?.id || 'Unknown Model';
    const totalInput = state.context_window.total_input_tokens || 0;
    const totalOutput = state.context_window.total_output_tokens || 0;
    const sessionId = state.session_id || state.conversation_id || null;

    const event = {
        timestamp,
        cwd: state.cwd || 'Global',
        source,
        session_id: sessionId,
        total_input: totalInput,
        total_output: totalOutput,
        current_input: currentInput,
        current_output: currentOutput,
        current_cache_read: currentCacheRead,
        model: modelName,
        state: agentState
    };

    // --- Session-aware matching ---
    // Priority 1: Match by source + session_id (prevents cross-agent phantom entries)
    let lastIdx = -1;
    if (sessionId) {
        for (let i = history.length - 1; i >= 0; i--) {
            if ((history[i].source || history[i].product) === source && history[i].session_id === sessionId) {
                lastIdx = i;
                break;
            }
        }
    }

    // Priority 2: No session_id → fallback to product match for legacy events.
    if (lastIdx === -1 && !sessionId) {
        for (let i = history.length - 1; i >= 0; i--) {
            if ((history[i].source || history[i].product) === source && !history[i].session_id) {
                lastIdx = i;
                break;
            }
        }
    }

    const lastEvent = lastIdx >= 0 ? history[lastIdx] : null;

    if (!lastEvent) {
        // First event for this session.
        // Extra guard: if idle and exact same token fingerprint already exists,
        // it's a stale session re-sending old data → update in-place, don't push new entry.
        if (agentState !== 'working' && agentState !== 'tool_use') {
            for (let i = history.length - 1; i >= 0; i--) {
                if ((history[i].source || history[i].product) === source &&
                    history[i].current_input === currentInput &&
                    history[i].current_output === currentOutput &&
                    history[i].total_input === totalInput &&
                    history[i].total_output === totalOutput) {
                    // Stale duplicate detected — update existing entry in place
                    history[i] = event;
                    return;
                }
            }
        }
        history.push(event);
    } else {
        const tokensChanged = Math.abs(lastEvent.current_input - currentInput) > 50 ||
                              Math.abs(lastEvent.current_output - currentOutput) > 50;
        const totalChanged = lastEvent.total_input !== totalInput || lastEvent.total_output !== totalOutput;
        const wasWorking = lastEvent.state === 'working';
        const isWorking = agentState === 'working';

        if (wasWorking || isWorking) {
            // Update the existing slot (streaming update or finalize)
            history[lastIdx] = event;
        } else if (tokensChanged || totalChanged) {
            // Push new entry when tokens meaningfully changed
            history.push(event);
        }
        // else: skip (idle with no change)
    }

    // Keep history capped at 100 entries
    if (history.length > 100) history.shift();
}

function sqliteJson(dbPath, query, cb) {
    if (!fs.existsSync(dbPath)) {
        cb(null, []);
        return;
    }
    execFile('sqlite3', ['-json', dbPath, query], { timeout: 10000, maxBuffer: 1024 * 1024 * 8 }, (err, stdout) => {
        if (err) {
            cb(err);
            return;
        }
        try {
            cb(null, stdout.trim() ? JSON.parse(stdout) : []);
        } catch (e) {
            cb(e);
        }
    });
}

function parseKv(body, key) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(body || '').match(new RegExp(`${escaped}=("[^"]*"|[^ ]+)`));
    if (!match) return null;
    const value = match[1];
    return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function parseIntKv(body, key) {
    const value = parseKv(body, key);
    const parsed = Number.parseInt(value || '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function pollCodex() {
    const where = `
        target = 'codex_otel.trace_safe'
        and feedback_log_body like '%event.name="codex.sse_event"%'
        and feedback_log_body like '%event.kind=response.completed%'
        and feedback_log_body like '%input_token_count=%'
    `;
    const query = pollState.codexLastLogId > 0
        ? `select id, ts, feedback_log_body from logs where id > ${pollState.codexLastLogId} and ${where} order by id asc limit 20`
        : `select id, ts, feedback_log_body from logs where ${where} order by id desc limit 1`;

    sqliteJson(CODEX_DB, query, (err, rows) => {
        if (err || !rows.length) return;
        if (pollState.codexLastLogId === 0) rows.reverse();

        rows.forEach(row => {
            const body = row.feedback_log_body || '';
            const sessionId = parseKv(body, 'conversation.id') || `codex-${row.id}`;
            const model = parseKv(body, 'model') || parseKv(body, 'slug') || 'codex';
            const inputTokens = parseIntKv(body, 'input_token_count');
            const outputTokens = parseIntKv(body, 'output_token_count');
            const cacheRead = parseIntKv(body, 'cached_token_count');
            const contextSize = Math.max(inputTokens + outputTokens + cacheRead, 1);

            processPayload({
                agent: 'codex',
                source: 'codex',
                product: 'codex',
                session_id: sessionId,
                conversation_id: sessionId,
                cwd: parseKv(body, 'cwd') || __dirname,
                model: { id: model, display_name: model },
                agent_state: 'idle',
                context_window: {
                    total_input_tokens: inputTokens + cacheRead,
                    total_output_tokens: outputTokens,
                    context_window_size: contextSize,
                    used_percentage: Math.min(100, ((inputTokens + outputTokens) / contextSize) * 100),
                    current_usage: {
                        input_tokens: inputTokens,
                        output_tokens: outputTokens,
                        cache_read_input_tokens: cacheRead
                    }
                }
            });
            pollState.codexLastLogId = Math.max(pollState.codexLastLogId, row.id);
        });
    });
}

function pollOpenCode() {
    const where = `
        json_extract(m.data, '$.role') = 'assistant'
        and json_extract(m.data, '$.tokens.input') is not null
        and (json_extract(m.data, '$.tokens.input') > 0 or json_extract(m.data, '$.tokens.output') > 0)
    `;
    const query = pollState.opencodeLastTime > 0
        ? `select m.id, m.session_id, m.time_created, m.data, s.directory from message m left join session s on s.id = m.session_id where m.time_created > ${pollState.opencodeLastTime} and ${where} order by m.time_created asc limit 20`
        : `select m.id, m.session_id, m.time_created, m.data, s.directory from message m left join session s on s.id = m.session_id where ${where} order by m.time_created desc limit 1`;

    sqliteJson(OPENCODE_DB, query, (err, rows) => {
        if (err || !rows.length) return;
        if (pollState.opencodeLastTime === 0) rows.reverse();

        rows.forEach(row => {
            let data;
            try {
                data = JSON.parse(row.data || '{}');
            } catch (e) {
                return;
            }

            const tokens = data.tokens || {};
            const cache = tokens.cache || {};
            const inputTokens = tokens.input || 0;
            const outputTokens = tokens.output || 0;
            const cacheRead = cache.read || 0;
            const totalTokens = tokens.total || inputTokens + outputTokens + cacheRead || 1;
            const model = data.modelID || data.model?.modelID || 'opencode';

            processPayload({
                agent: 'opencode',
                source: 'opencode',
                product: 'opencode',
                session_id: row.session_id,
                conversation_id: row.session_id,
                cwd: row.directory || data.path?.cwd || __dirname,
                model: { id: model, display_name: model },
                agent_state: 'idle',
                context_window: {
                    total_input_tokens: inputTokens + cacheRead,
                    total_output_tokens: outputTokens,
                    context_window_size: Math.max(totalTokens, 1),
                    used_percentage: Math.min(100, ((inputTokens + outputTokens) / Math.max(totalTokens, 1)) * 100),
                    current_usage: {
                        input_tokens: inputTokens,
                        output_tokens: outputTokens,
                        cache_read_input_tokens: cacheRead
                    }
                }
            });
            pollState.opencodeLastTime = Math.max(pollState.opencodeLastTime, row.time_created);
        });
    });
}

function pollAgentDatabases() {
    pollCodex();
    pollOpenCode();
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = req.url.split('?')[0];

    if (req.method === 'GET' && parsedUrl === '/') {
        fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, html) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error loading dashboard UI');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        });
    }
    else if (req.method === 'GET' && (parsedUrl === '/favicon.png' || parsedUrl === '/favicon.ico')) {
        fs.readFile(path.join(__dirname, 'favicon.png'), (err, content) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(content);
        });
    }
    else if (req.method === 'POST' && parsedUrl === '/api/metadata') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                const result = processPayload(payload);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, ...result }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
            }
        });
    }
    else if (req.method === 'GET' && parsedUrl === '/api/stream') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        // Send current state immediately on connect
        const best = computeBestState();
        const initialData = JSON.stringify({ latestState: best, latestStates, history });
        res.write(`data: ${initialData}\n\n`);

        // Heartbeat every 15s
        const heartbeat = setInterval(() => {
            try {
                res.write(': heartbeat\n\n');
            } catch (e) {
                clearInterval(heartbeat);
            }
        }, 15000);

        clients.push(res);

        req.on('close', () => {
            clearInterval(heartbeat);
            const index = clients.indexOf(res);
            if (index !== -1) clients.splice(index, 1);
        });
    }
    else if (req.method === 'GET' && parsedUrl === '/api/state') {
        const best = computeBestState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ latestState: best, latestStates, history }));
    }
    else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`[Dashboard Server] Running at http://localhost:${PORT}`);
    console.log(`[Dashboard Server] ${history.length} history events loaded.`);
    pollAgentDatabases();
    setInterval(pollAgentDatabases, 5000);
});
