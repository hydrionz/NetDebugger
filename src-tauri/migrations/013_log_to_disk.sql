-- Per-session disk logging: log_to_disk flag + user-chosen log directory
ALTER TABLE sessions ADD COLUMN log_to_disk INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN log_dir TEXT;