CREATE TABLE action_history_archives (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  first_event_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX action_history_archives_user_idx
  ON action_history_archives(user_id, status, created_at DESC);

CREATE TABLE action_history_states (
  audit_log_id TEXT PRIMARY KEY REFERENCES audit_logs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived', 'deleted')),
  archive_id TEXT REFERENCES action_history_archives(id) ON DELETE SET NULL,
  archived_at TEXT,
  restored_at TEXT,
  deleted_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX action_history_states_user_idx
  ON action_history_states(user_id, state, updated_at DESC);
