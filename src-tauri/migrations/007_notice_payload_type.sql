-- Widen messages.payload_type CHECK to allow connection-status notices ('notice').
-- SQLite cannot ALTER a CHECK constraint, so rebuild the table (same pattern as 004).

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

ALTER TABLE messages RENAME TO messages_old;

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    client_id TEXT,
    direction TEXT NOT NULL CHECK(direction IN ('in','out')),
    payload_type TEXT NOT NULL CHECK(payload_type IN ('text','binary','notice')),
    payload BLOB NOT NULL,
    size INTEGER NOT NULL,
    timestamp INTEGER NOT NULL,
    endpoint TEXT,
    sender TEXT
);

INSERT INTO messages (id, session_id, client_id, direction, payload_type, payload, size, timestamp, endpoint, sender)
SELECT id, session_id, client_id, direction, payload_type, payload, size, timestamp, endpoint, sender
FROM messages_old;

DROP TABLE messages_old;

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);

COMMIT;

PRAGMA foreign_keys = ON;
