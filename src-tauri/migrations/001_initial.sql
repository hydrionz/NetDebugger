CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
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

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK(direction IN ('in','out')),
    payload_type TEXT NOT NULL CHECK(payload_type IN ('text','binary')),
    payload BLOB NOT NULL,
    size INTEGER NOT NULL,
    timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
