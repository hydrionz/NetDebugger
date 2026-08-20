-- Client auto-reconnect interval in seconds (NULL = disabled, 0 = disabled).
ALTER TABLE sessions ADD COLUMN auto_reconnect INTEGER;
