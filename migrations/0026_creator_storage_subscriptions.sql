PRAGMA foreign_keys = ON;

CREATE TABLE creator_storage_subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_subscription_item_id TEXT,
  additional_blocks INTEGER NOT NULL DEFAULT 0 CHECK (additional_blocks BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'none' CHECK (
    status IN ('none', 'checkout_pending', 'trialing', 'active', 'past_due', 'unpaid', 'paused', 'canceled', 'incomplete')
  ),
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  grace_ends_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX creator_storage_subscriptions_status_idx
  ON creator_storage_subscriptions(status, grace_ends_at, updated_at);

CREATE TABLE creator_storage_billing_config (
  plan_key TEXT PRIMARY KEY,
  stripe_product_id TEXT,
  stripe_price_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE creator_storage_upload_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX creator_storage_upload_reservations_user_idx
  ON creator_storage_upload_reservations(user_id, expires_at);

CREATE TABLE creator_storage_subscription_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  previous_blocks INTEGER NOT NULL DEFAULT 0,
  next_blocks INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  stripe_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX creator_storage_subscription_events_user_idx
  ON creator_storage_subscription_events(user_id, created_at);
