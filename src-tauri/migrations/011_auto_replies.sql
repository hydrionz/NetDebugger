-- Auto-reply rules for server sessions: JSON array of {id, enabled, match_type, pattern, reply, reply_type, delay_ms}
ALTER TABLE sessions ADD COLUMN auto_replies TEXT;
