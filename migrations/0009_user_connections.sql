PRAGMA foreign_keys = ON;

CREATE TABLE user_connections (
  id TEXT PRIMARY KEY,
  user_low_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'blocked')),
  low_shares_progress INTEGER NOT NULL DEFAULT 0 CHECK (low_shares_progress IN (0, 1)),
  high_shares_progress INTEGER NOT NULL DEFAULT 0 CHECK (high_shares_progress IN (0, 1)),
  blocker_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (user_low_id < user_high_id),
  UNIQUE(user_low_id, user_high_id)
);
CREATE INDEX user_connections_user_low_idx ON user_connections(user_low_id, status, updated_at);
CREATE INDEX user_connections_user_high_idx ON user_connections(user_high_id, status, updated_at);

CREATE TABLE connection_messages (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES user_connections(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX connection_messages_thread_idx
  ON connection_messages(connection_id, created_at DESC);
