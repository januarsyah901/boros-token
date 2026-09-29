/**
 * SQLite Database layer for Boros Token
 * Uses built-in node:sqlite (zero external dependencies).
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { calculateCost } = require('./pricing_registry');

const DEFAULT_DB_PATH = path.join(__dirname, 'boros.db');

class BorosDatabase {
    constructor(dbPath = DEFAULT_DB_PATH) {
        this.dbPath = dbPath;
        this.db = null;
        this.init();
    }

    init() {
        this.db = new DatabaseSync(this.dbPath);
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA synchronous = NORMAL;');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                agent TEXT NOT NULL,
                source TEXT NOT NULL,
                session_id TEXT,
                model TEXT,
                state TEXT,
                current_input INTEGER DEFAULT 0,
                current_output INTEGER DEFAULT 0,
                current_cache_read INTEGER DEFAULT 0,
                total_input INTEGER DEFAULT 0,
                total_output INTEGER DEFAULT 0,
                context_window INTEGER DEFAULT 0,
                cwd TEXT,
                cost REAL DEFAULT 0.0,
                raw_payload TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
            CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent);
            CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
            CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
            CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);

            CREATE TABLE IF NOT EXISTS poll_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS active_sessions (
                session_key TEXT PRIMARY KEY,
                agent TEXT,
                source TEXT,
                session_id TEXT,
                state TEXT,
                model TEXT,
                payload TEXT,
                updated_at TEXT NOT NULL
            );
        `);
    }

    migrateFromHistoryJson(jsonPath) {
        try {
            if (!fs.existsSync(jsonPath)) return 0;
            const countRow = this.db.prepare('SELECT COUNT(*) as count FROM events').get();
            if (countRow && countRow.count > 0) {
                return 0; // Already migrated or has records
            }

            const raw = fs.readFileSync(jsonPath, 'utf8');
            const data = JSON.parse(raw);
            const history = data.history || [];
            if (!history.length) return 0;

            const insertStmt = this.db.prepare(`
                INSERT INTO events (
                    timestamp, agent, source, session_id, model, state,
                    current_input, current_output, current_cache_read,
                    total_input, total_output, context_window, cwd, cost, raw_payload
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            let migrated = 0;
            for (const item of history) {
                const modelName = item.model || 'unknown';
                const inTokens = item.current_input || 0;
                const outTokens = item.current_output || 0;
                const cacheTokens = item.current_cache_read || 0;
                const costCalc = calculateCost(modelName, inTokens, outTokens, cacheTokens);

                insertStmt.run(
                    item.timestamp || new Date().toISOString(),
                    item.source || item.agent || 'unknown',
                    item.source || 'unknown',
                    item.session_id || null,
                    modelName,
                    item.state || 'idle',
                    inTokens,
                    outTokens,
                    cacheTokens,
                    item.total_input || 0,
                    item.total_output || 0,
                    item.context_window || 0,
                    item.cwd || 'Global',
                    costCalc.totalCost,
                    JSON.stringify(item)
                );
                migrated++;
            }

            console.log(`[Database] Migrated ${migrated} past events from history_log.json into SQLite.`);
            return migrated;
        } catch (e) {
            console.error('[Database] Migration error:', e);
            return 0;
        }
    }

    insertEvent(event) {
        const modelName = event.model || 'unknown';
        const inTokens = event.current_input || 0;
        const outTokens = event.current_output || 0;
        const cacheTokens = event.current_cache_read || 0;
        const costCalc = calculateCost(modelName, inTokens, outTokens, cacheTokens);

        const stmt = this.db.prepare(`
            INSERT INTO events (
                timestamp, agent, source, session_id, model, state,
                current_input, current_output, current_cache_read,
                total_input, total_output, context_window, cwd, cost, raw_payload
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            event.timestamp || new Date().toISOString(),
            event.agent || event.source || 'unknown',
            event.source || 'unknown',
            event.session_id || null,
            modelName,
            event.state || 'idle',
            inTokens,
            outTokens,
            cacheTokens,
            event.total_input || 0,
            event.total_output || 0,
            event.context_window || 0,
            event.cwd || 'Global',
            costCalc.totalCost,
            event.raw_payload || JSON.stringify(event)
        );
    }

    getRecentEvents(limit = 100) {
        const stmt = this.db.prepare(`
            SELECT id, timestamp, agent, source, session_id, model, state,
                   current_input, current_output, current_cache_read,
                   total_input, total_output, context_window, cwd, cost
            FROM events
            ORDER BY id DESC
            LIMIT ?
        `);
        const rows = stmt.all(limit);
        return rows.reverse();
    }

    getFilteredEvents({ agent, from, to, limit = 100, offset = 0 }) {
        let sql = `
            SELECT id, timestamp, agent, source, session_id, model, state,
                   current_input, current_output, current_cache_read,
                   total_input, total_output, context_window, cwd, cost
            FROM events
            WHERE 1=1
        `;
        const params = [];

        if (agent && agent !== 'all') {
            sql += ' AND (agent = ? OR source = ?)';
            params.push(agent, agent);
        }
        if (from) {
            sql += ' AND timestamp >= ?';
            params.push(from);
        }
        if (to) {
            sql += ' AND timestamp <= ?';
            params.push(to);
        }

        sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const stmt = this.db.prepare(sql);
        return stmt.all(...params);
    }

    getTotalEventCount() {
        const row = this.db.prepare('SELECT COUNT(*) as count FROM events').get();
        return row ? row.count : 0;
    }

    getDailyStats(days = 30) {
        const stmt = this.db.prepare(`
            SELECT substr(timestamp, 1, 10) as date,
                   agent,
                   count(*) as requests,
                   sum(current_input) as input_tokens,
                   sum(current_output) as output_tokens,
                   sum(current_cache_read) as cache_tokens,
                   sum(cost) as total_cost
            FROM events
            WHERE timestamp >= datetime('now', '-' || ? || ' days')
            GROUP BY date, agent
            ORDER BY date ASC
        `);
        return stmt.all(days);
    }

    getModelStats() {
        const stmt = this.db.prepare(`
            SELECT model,
                   source,
                   count(*) as requests,
                   sum(current_input) as input_tokens,
                   sum(current_output) as output_tokens,
                   sum(current_cache_read) as cache_tokens,
                   sum(cost) as total_cost
            FROM events
            GROUP BY model, source
            ORDER BY total_cost DESC
        `);
        return stmt.all();
    }

    savePollState(key, val) {
        const now = new Date().toISOString();
        const strVal = typeof val === 'string' ? val : JSON.stringify(val);
        const stmt = this.db.prepare(`
            INSERT INTO poll_state (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `);
        stmt.run(key, strVal, now);
    }

    loadPollState(key, fallback = null) {
        try {
            const stmt = this.db.prepare('SELECT value FROM poll_state WHERE key = ?');
            const row = stmt.get(key);
            if (!row) return fallback;
            return JSON.parse(row.value);
        } catch (e) {
            return fallback;
        }
    }

    saveActiveSession(sessionKey, agent, source, sessionId, state, model, payload) {
        const now = new Date().toISOString();
        const stmt = this.db.prepare(`
            INSERT INTO active_sessions (session_key, agent, source, session_id, state, model, payload, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_key) DO UPDATE SET
                agent = excluded.agent,
                source = excluded.source,
                session_id = excluded.session_id,
                state = excluded.state,
                model = excluded.model,
                payload = excluded.payload,
                updated_at = excluded.updated_at
        `);
        stmt.run(sessionKey, agent, source, sessionId, state, model, JSON.stringify(payload), now);
    }

    loadActiveSessions() {
        const stmt = this.db.prepare('SELECT session_key, payload FROM active_sessions');
        const rows = stmt.all();
        const map = {};
        for (const row of rows) {
            try {
                map[row.session_key] = JSON.parse(row.payload);
            } catch (e) {}
        }
        return map;
    }

    close() {
        if (this.db) {
            this.db.close();
        }
    }
}

module.exports = {
    BorosDatabase,
    dbInstance: new BorosDatabase()
};
