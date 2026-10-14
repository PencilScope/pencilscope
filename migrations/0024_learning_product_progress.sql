CREATE TABLE learning_product_progress (
  id TEXT PRIMARY KEY,
  learning_product_id TEXT NOT NULL REFERENCES learning_products(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('not_started', 'in_progress', 'completed')),
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  position_seconds REAL NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
  duration_seconds REAL NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  total_seconds INTEGER NOT NULL DEFAULT 0 CHECK (total_seconds >= 0),
  first_opened_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (learning_product_id, user_id)
);

CREATE INDEX learning_product_progress_user_idx
  ON learning_product_progress(user_id, last_opened_at);

CREATE TABLE learning_product_activity (
  id TEXT PRIMARY KEY,
  learning_product_id TEXT NOT NULL REFERENCES learning_products(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('opened', 'progressed', 'paused', 'completed', 'assessment')),
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  position_seconds REAL NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
  seconds_spent INTEGER NOT NULL DEFAULT 0 CHECK (seconds_spent >= 0),
  created_at TEXT NOT NULL
);

CREATE INDEX learning_product_activity_history_idx
  ON learning_product_activity(user_id, learning_product_id, created_at DESC);
