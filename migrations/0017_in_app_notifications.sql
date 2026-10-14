PRAGMA foreign_keys = ON;

CREATE TABLE notification_campaigns (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 2 AND 2000),
  category TEXT NOT NULL DEFAULT 'system'
    CHECK (category IN ('system', 'learning', 'creator', 'social', 'billing', 'security')),
  priority TEXT NOT NULL DEFAULT 'info'
    CHECK (priority IN ('info', 'important', 'warning', 'critical')),
  action_url TEXT,
  action_label TEXT,
  audience_type TEXT NOT NULL
    CHECK (audience_type IN ('all', 'learners', 'creators', 'specific_users', 'country', 'interest')),
  audience_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'cancelled', 'expired')),
  recipient_count INTEGER NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  published_at TEXT,
  expires_at TEXT
);

CREATE INDEX notification_campaigns_status_idx
  ON notification_campaigns(status, published_at DESC);

CREATE TABLE in_app_notifications (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES notification_campaigns(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TEXT NOT NULL,
  read_at TEXT,
  dismissed_at TEXT,
  clicked_at TEXT,
  UNIQUE (campaign_id, user_id)
);

CREATE INDEX in_app_notifications_user_idx
  ON in_app_notifications(user_id, dismissed_at, read_at, delivered_at DESC);
CREATE INDEX in_app_notifications_campaign_idx
  ON in_app_notifications(campaign_id, read_at, clicked_at);
