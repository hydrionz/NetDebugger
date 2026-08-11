-- Store sender address on messages so history keeps sender info
-- even after clients table is cleared on app restart.
-- messages.sender: sender display for inbound messages (TEXT, NULL for legacy rows).
ALTER TABLE messages ADD COLUMN sender TEXT;
