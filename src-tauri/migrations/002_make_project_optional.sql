-- Make project_id optional so sessions can exist independently.
-- SQLite does not support ALTER TABLE DROP NOT NULL directly.

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS sessions_new (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    protocol TEXT NOT NULL CHECK(protocol IN ('ws')),
    role TEXT NOT NULL CHECK(role IN ('server','client')),
    status TEXT NOT NULL CHECK(status IN ('idle','starting','running','error','closed')),
    bind_addr TEXT,
    target_url TEXT,
    local_addr TEXT,
    remote_addr TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

INSERT INTO sessions_new (
    id, project_id, protocol, role, status, bind_addr, target_url,
    local_addr, remote_addr, created_at, updated_at
)
SELECT
    id, project_id, protocol, role, status, bind_addr, target_url,
    local_addr, remote_addr, created_at, updated_at
FROM sessions;

DROP TABLE sessions;

ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);

COMMIT;

PRAGMA foreign_keys = ON;
