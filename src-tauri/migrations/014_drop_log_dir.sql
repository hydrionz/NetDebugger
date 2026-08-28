-- Log directory is now a global setting (store.bin), not per-session
ALTER TABLE sessions DROP COLUMN log_dir;