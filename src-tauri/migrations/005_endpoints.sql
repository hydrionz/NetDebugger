-- WS server endpoint path support.
-- sessions.endpoints: JSON array of endpoint paths (["/echo","/chat"]) or NULL (= accept all paths).
-- clients.endpoint: path the client connected through (TEXT, NULL for legacy rows).
-- messages.endpoint: endpoint a message belongs to (TEXT, NULL for legacy rows).
ALTER TABLE sessions ADD COLUMN endpoints TEXT;
ALTER TABLE clients ADD COLUMN endpoint TEXT;
ALTER TABLE messages ADD COLUMN endpoint TEXT;