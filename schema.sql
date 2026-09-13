DROP TABLE IF EXISTS monitors_state;
DROP TABLE IF EXISTS check_history;

CREATE TABLE monitors_state (
    monitor_id TEXT PRIMARY KEY,
    status TEXT NOT NULL, -- 'UP', 'DEGRADED', 'DOWN'
    last_checked_at INTEGER,
    last_latency INTEGER,
    fail_count INTEGER DEFAULT 0,
    first_fail_time INTEGER,
    last_error TEXT
);

CREATE TABLE check_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    status TEXT NOT NULL,
    latency INTEGER,
    message TEXT
);

CREATE INDEX idx_history_monitor_time ON check_history(monitor_id, timestamp);

CREATE INDEX idx_history_timestamp ON check_history(timestamp);
