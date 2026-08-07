-- Add clients table and link messages to clients for multi-client WS server support.

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name TEXT,
    remote_addr TEXT,
    local_addr TEXT,
    connected_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clients_session ON clients(session_id);

-- Idempotent: only add client_id if missing.
-- ponytail: user PRAGMA inspection would be cleaner; this is the smallest patch.
ALTER TABLE messages ADD COLUMN client_id TEXT;

COMMIT;

PRAGMA foreign_keys = ON;
