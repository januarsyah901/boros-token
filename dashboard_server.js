const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { dbInstance } = require('./db');
const { PRICING_TABLE, resolvePricing, calculateCost } = require('./pricing_registry');

const PORT = process.env.BOROS_PORT || 4000;
const DB_FILE = path.join(__dirname, 'history_log.json');
const CODEX_DB = path.join(process.env.HOME || '', '.codex', 'logs_2.sqlite');
const CODEX_STATE_DB = path.join(process.env.HOME || '', '.codex', 'state_5.sqlite');
const OPENCODE_DB = path.join(process.env.HOME || '', '.local', 'share', 'opencode', 'opencode.db');

// Latest state keyed by source/session so multiple agents can coexist.
let latestStates = {};
// Single latestState: the most recently received state (for backwards compat)
let latestState = null;
let history = [];
const clients = [];
const pollState = {
    codexLastLogId: 0,
    opencodeLastTime: 0,
    claudeFileOffsets: {},
    codexThreadTokens: {}
};

// Load state from disk and SQLite on startup
function loadStateFromDisk() {
    try {
        // 1. Initial migration to SQLite if needed
        if (fs.existsSync(DB_FILE)) {
            dbInstance.migrateFromHistoryJson(DB_FILE);

            const raw = fs.readFileSync(DB_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            latestState = parsed.latestState || null;
            latestStates = parsed.latestStates || {};
            history = parsed.history || [];

            // Downgrade stale working states (> 2 min old) to idle on startup
            const now = Date.now();
            Object.values(latestStates).forEach(s => {
                if (s.agent_state === 'working' && (now - new Date(s._receivedAt || 0).getTime()) > 2 * 60 * 1000) {
                    s.agent_state = 'idle';
                }
            });

            console.log(`[Dashboard Server] Loaded history from disk. In-memory events: ${history.length}, SQLite events: ${dbInstance.getTotalEventCount()}`);
        }

        // 2. Restore persistent pollState from SQLite
        const savedPoll = dbInstance.loadPollState('agent_poll_state', null);
        if (savedPoll) {
            if (savedPoll.codexLastLogId) pollState.codexLastLogId = savedPoll.codexLastLogId;
            if (savedPoll.opencodeLastTime) pollState.opencodeLastTime = savedPoll.opencodeLastTime;
            if (savedPoll.claudeFileOffsets) pollState.claudeFileOffsets = savedPoll.claudeFileOffsets;
            if (savedPoll.codexThreadTokens) pollState.codexThreadTokens = savedPoll.codexThreadTokens;
            console.log('[Dashboard Server] Restored persistent poller state from database.');
        }

        // 3. Fallback active sessions from SQLite if empty
        if (Object.keys(latestStates).length === 0) {
            const dbSessions = dbInstance.loadActiveSessions();
            if (Object.keys(dbSessions).length > 0) {
                latestStates = dbSessions;
                console.log(`[Dashboard Server] Restored ${Object.keys(latestStates).length} active sessions from database.`);
            }
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
        claudecode: 'Claude Code',
        claude: 'Claude Code',
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

    // Persist active session in database
    const modelName = payload.model?.display_name || payload.model?.id || 'Unknown Model';
    dbInstance.saveActiveSession(
        sessionKey,
        payload.agent,
        source,
        payload.session_id || payload.conversation_id || 'global',
        payload.agent_state || 'idle',
        modelName,
        payload
    );

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
// Pick the most recently received state that is actively working (received within 2 min),
// OR the absolute most recent if all are idle.
function computeBestState() {
    const all = Object.values(latestStates);
    if (all.length === 0) return latestState;

    const now = Date.now();
    const WORKING_TIMEOUT_MS = 2 * 60 * 1000;

    // Prefer states actively working (received within 2 minutes)
    const working = all.filter(s => {
        if (s.agent_state !== 'working') return false;
        const rec = new Date(s._receivedAt || 0).getTime();
        return (now - rec) < WORKING_TIMEOUT_MS;
    });

    if (working.length > 0) {
        return working.sort((a, b) => new Date(b._receivedAt) - new Date(a._receivedAt))[0];
    }

    // Fall back to most recently received across all agents
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
//  - If idle->idle with no token change for same session: skip
//  - Extra: if idle and exact same tokens exist in history: update in-place
//  - Otherwise: push new event and insert into SQLite
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

    const costDetails = calculateCost(modelName, currentInput, currentOutput, currentCacheRead);

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
        state: agentState,
        cost: costDetails.totalCost
    };

    // --- Session-aware matching ---
    let lastIdx = -1;
    if (sessionId) {
        for (let i = history.length - 1; i >= 0; i--) {
            if ((history[i].source || history[i].product) === source && history[i].session_id === sessionId) {
                lastIdx = i;
                break;
            }
        }
    }

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
        // First event for this session
        if (agentState !== 'working' && agentState !== 'tool_use') {
            for (let i = history.length - 1; i >= 0; i--) {
                if ((history[i].source || history[i].product) === source &&
                    history[i].current_input === currentInput &&
                    history[i].current_output === currentOutput &&
                    history[i].total_input === totalInput &&
                    history[i].total_output === totalOutput) {
                    history[i] = event;
                    return;
                }
            }
        }
        history.push(event);
        dbInstance.insertEvent(event);
    } else {
        const tokensChanged = Math.abs(lastEvent.current_input - currentInput) > 50 ||
                              Math.abs(lastEvent.current_output - currentOutput) > 50;
        const totalChanged = lastEvent.total_input !== totalInput || lastEvent.total_output !== totalOutput;
        const wasWorking = lastEvent.state === 'working';
        const isWorking = agentState === 'working';

        if (wasWorking || isWorking) {
            // Update the existing slot (streaming update or finalize)
            history[lastIdx] = event;
            if (!isWorking && wasWorking) {
                // Finalized turn: record to SQLite
                dbInstance.insertEvent(event);
            }
        } else if (tokensChanged || totalChanged) {
            // Push new entry when tokens meaningfully changed
            history.push(event);
            dbInstance.insertEvent(event);
        }
    }

    // Keep in-memory history window at 500 entries (SQLite preserves full history)
    if (history.length > 500) history.shift();
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
    // 1. Poll from state_5.sqlite if exists (new Codex versions)
    if (fs.existsSync(CODEX_STATE_DB)) {
        const query = "select id, model, tokens_used, cwd from threads where tokens_used > 0";
        sqliteJson(CODEX_STATE_DB, query, (err, rows) => {
            if (err || !rows || !rows.length) return;

            if (!pollState.codexThreadTokens) {
                pollState.codexThreadTokens = {};
            }

            rows.forEach(row => {
                const threadId = row.id;
                const tokensUsed = parseInt(row.tokens_used) || 0;
                const model = row.model || 'codex';
                const cwd = row.cwd || __dirname;

                const prevTokens = pollState.codexThreadTokens[threadId];

                if (prevTokens === undefined) {
                    pollState.codexThreadTokens[threadId] = tokensUsed;
                    return;
                }

                if (tokensUsed > prevTokens) {
                    const diff = tokensUsed - prevTokens;
                    pollState.codexThreadTokens[threadId] = tokensUsed;

                    processPayload({
                        agent: 'codex',
                        source: 'codex',
                        product: 'codex',
                        session_id: threadId,
                        conversation_id: threadId,
                        cwd: cwd,
                        model: { id: model, display_name: model },
                        agent_state: 'idle',
                        context_window: {
                            total_input_tokens: tokensUsed,
                            total_output_tokens: 0,
                            context_window_size: Math.max(tokensUsed, 200000),
                            used_percentage: Math.min(100, (tokensUsed / Math.max(tokensUsed, 200000)) * 100),
                            current_usage: {
                                input_tokens: diff,
                                output_tokens: 0,
                                cache_read_input_tokens: 0
                            }
                        }
                    });
                }
            });
        });
    }

    // 2. Poll from logs_2.sqlite (backward compatibility)
    if (fs.existsSync(CODEX_DB)) {
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
            if (err || !rows || !rows.length) return;
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
        if (err || !rows || !rows.length) return;
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

function pollClaude() {
    const CLAUDE_DIR = path.join(process.env.HOME || '', '.claude', 'projects');
    if (!fs.existsSync(CLAUDE_DIR)) return;

    if (!pollState.claudeFileOffsets) {
        pollState.claudeFileOffsets = {};
    }

    try {
        const projects = fs.readdirSync(CLAUDE_DIR);
        for (const project of projects) {
            const projectPath = path.join(CLAUDE_DIR, project);
            if (fs.statSync(projectPath).isDirectory()) {
                const files = fs.readdirSync(projectPath);
                for (const file of files) {
                    if (file.endsWith('.jsonl')) {
                        const filePath = path.join(projectPath, file);
                        try {
                            const content = fs.readFileSync(filePath, 'utf8');
                            const lines = content.split('\n').filter(Boolean);
                            const lastRead = pollState.claudeFileOffsets[filePath] || 0;

                            if (lastRead === 0) {
                                pollState.claudeFileOffsets[filePath] = lines.length;
                                for (let i = lines.length - 1; i >= 0; i--) {
                                    const parsed = JSON.parse(lines[i]);
                                    if (parsed.type === 'assistant' && parsed.message?.usage) {
                                        processClaudeLine(parsed);
                                        break;
                                    }
                                }
                                continue;
                            }

                            for (let i = lastRead; i < lines.length; i++) {
                                try {
                                    const parsed = JSON.parse(lines[i]);
                                    if (parsed.type === 'assistant' && parsed.message?.usage) {
                                        processClaudeLine(parsed);
                                    }
                                } catch (err) {
                                    console.error('Error parsing Claude JSONL line:', err);
                                }
                            }
                            pollState.claudeFileOffsets[filePath] = lines.length;
                        } catch (e) {
                            console.error(`Error polling Claude file ${filePath}:`, e);
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error('Error scanning Claude projects dir:', e);
    }
}

function processClaudeLine(parsed) {
    const usage = parsed.message.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const totalTokens = inputTokens + outputTokens + cacheRead;
    const model = parsed.message.model || 'claude-3-5-sonnet';
    const sessionId = parsed.sessionId || 'global';

    let agentState = 'idle';
    if (parsed.message.stop_reason === 'tool_use') {
        agentState = 'tool_use';
    }

    processPayload({
        agent: 'claudecode',
        source: 'claudecode',
        product: 'claudecode',
        session_id: sessionId,
        conversation_id: sessionId,
        cwd: parsed.cwd || __dirname,
        model: { id: model, display_name: model },
        agent_state: agentState,
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
}

function pollAgentDatabases() {
    pollCodex();
    pollOpenCode();
    pollClaude();

    // Persist poller offsets to database after polling cycle
    dbInstance.savePollState('agent_poll_state', pollState);
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

    const [pathname, search] = req.url.split('?');
    const queryParams = new URLSearchParams(search || '');

    if (req.method === 'GET' && pathname === '/') {
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
    else if (req.method === 'GET' && (pathname === '/favicon.png' || pathname === '/favicon.ico')) {
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
    else if (req.method === 'GET' && pathname === '/api/health') {
        const payload = {
            status: 'ok',
            uptime: Math.round(process.uptime()),
            eventsCount: dbInstance.getTotalEventCount(),
            clientsConnected: clients.length,
            timestamp: new Date().toISOString()
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
    }
    else if (req.method === 'GET' && pathname === '/api/pricing') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(PRICING_TABLE));
    }
    else if (req.method === 'GET' && pathname === '/api/stats/daily') {
        const days = parseInt(queryParams.get('days') || '30', 10);
        const stats = dbInstance.getDailyStats(days);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
    }
    else if (req.method === 'GET' && pathname === '/api/stats/models') {
        const stats = dbInstance.getModelStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
    }
    else if (req.method === 'GET' && pathname === '/api/history') {
        const agent = queryParams.get('agent');
        const from = queryParams.get('from');
        const to = queryParams.get('to');
        const limit = parseInt(queryParams.get('limit') || '100', 10);
        const offset = parseInt(queryParams.get('offset') || '0', 10);

        const events = dbInstance.getFilteredEvents({ agent, from, to, limit, offset });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            total: dbInstance.getTotalEventCount(),
            count: events.length,
            events
        }));
    }
    else if (req.method === 'POST' && pathname === '/api/metadata') {
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
    else if (req.method === 'GET' && pathname === '/api/stream') {
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
    else if (req.method === 'GET' && pathname === '/api/state') {
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
    console.log(`[Dashboard Server] ${history.length} in-memory events loaded.`);
    pollAgentDatabases();
    setInterval(pollAgentDatabases, 5000);
});
