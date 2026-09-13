-- Safe for existing databases; do not run schema.sql against production.
CREATE INDEX IF NOT EXISTS idx_history_timestamp ON check_history(timestamp);
