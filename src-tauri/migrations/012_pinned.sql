-- Pin messages: keep pinned messages when clearing
ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(session_id, pinned);
