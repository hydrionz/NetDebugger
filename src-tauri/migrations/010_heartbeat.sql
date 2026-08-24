-- Heartbeat (auto Ping) interval in seconds for client sessions (NULL/0 = disabled).
ALTER TABLE sessions ADD COLUMN heartbeat_interval INTEGER;
