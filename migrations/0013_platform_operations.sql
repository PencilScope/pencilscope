ALTER TABLE courses ADD COLUMN listing_status TEXT NOT NULL DEFAULT 'listed'
  CHECK (listing_status IN ('listed', 'unlisted', 'delisted'));
ALTER TABLE courses ADD COLUMN delisted_at TEXT;
ALTER TABLE courses ADD COLUMN delisted_by TEXT REFERENCES users(id);
ALTER TABLE courses ADD COLUMN delisted_reason TEXT;
CREATE INDEX courses_listing_idx ON courses(status, listing_status, published_at);

ALTER TABLE course_members ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE course_members ADD COLUMN invited_by TEXT REFERENCES users(id);

CREATE TABLE course_member_invitations (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  member_role TEXT NOT NULL CHECK (
    member_role IN ('administrator', 'instructor', 'facilitator', 'editor')
  ),
  invited_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  accepted_by TEXT REFERENCES users(id),
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX course_member_invites_course_idx
  ON course_member_invitations(course_id, status, created_at);

CREATE TABLE platform_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system_admin', 'support', 'finance', 'auditor')),
  granted_by TEXT REFERENCES users(id),
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (user_id, role)
);

INSERT OR IGNORE INTO platform_roles (user_id, role, granted_by, granted_at)
SELECT id, 'system_admin', id, datetime('now') FROM users WHERE role = 'admin';

CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  ip_hash TEXT,
  user_agent TEXT
);
CREATE INDEX user_sessions_active_idx
  ON user_sessions(revoked_at, expires_at, last_seen_at);
CREATE INDEX user_sessions_user_idx
  ON user_sessions(user_id, revoked_at, last_seen_at);

CREATE TABLE payment_transactions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_transaction_id TEXT NOT NULL,
  transaction_type TEXT NOT NULL CHECK (
    transaction_type IN ('payment', 'refund', 'dispute', 'adjustment', 'payout')
  ),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(provider, provider_transaction_id, transaction_type)
);
CREATE INDEX payment_transactions_order_idx
  ON payment_transactions(order_id, occurred_at);

INSERT OR IGNORE INTO payment_transactions
  (id, order_id, provider, provider_transaction_id, transaction_type,
   amount_cents, currency, status, metadata_json, occurred_at, created_at)
SELECT 'payment-' || id, id, 'stripe',
  COALESCE(stripe_payment_intent_id, stripe_checkout_session_id),
  'payment', amount_cents, currency, status, '{}', updated_at, created_at
FROM orders WHERE status = 'paid';

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL CHECK (media_type IN ('video', 'audio', 'image', 'document')),
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare_stream', 'r2', 'external')),
  provider_asset_id TEXT,
  storage_key TEXT,
  external_url TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'uploading', 'processing', 'ready', 'failed', 'archived')),
  duration_seconds INTEGER,
  size_bytes INTEGER,
  mime_type TEXT,
  thumbnail_url TEXT,
  captions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX media_assets_owner_idx ON media_assets(owner_user_id, media_type, status, updated_at);

CREATE TABLE lesson_media (
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  media_asset_id TEXT NOT NULL REFERENCES media_assets(id),
  position INTEGER NOT NULL DEFAULT 1,
  required_percent INTEGER NOT NULL DEFAULT 90 CHECK (required_percent BETWEEN 1 AND 100),
  PRIMARY KEY (lesson_id, media_asset_id)
);

CREATE TABLE media_playback_progress (
  media_asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position_seconds INTEGER NOT NULL DEFAULT 0,
  watched_percent INTEGER NOT NULL DEFAULT 0 CHECK (watched_percent BETWEEN 0 AND 100),
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (media_asset_id, user_id)
);

CREATE TABLE ebooks (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  learning_product_id TEXT REFERENCES learning_products(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  audience TEXT NOT NULL,
  cover_asset_id TEXT REFERENCES media_assets(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'delisted', 'archived')),
  current_version INTEGER NOT NULL DEFAULT 1,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ebooks_creator_idx ON ebooks(creator_id, status, updated_at);

CREATE TABLE ebook_chapters (
  id TEXT PRIMARY KEY,
  ebook_id TEXT NOT NULL REFERENCES ebooks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL DEFAULT '{"blocks":[]}',
  position INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (ebook_id, position)
);

CREATE TABLE ebook_reading_progress (
  ebook_id TEXT NOT NULL REFERENCES ebooks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chapter_id TEXT REFERENCES ebook_chapters(id) ON DELETE SET NULL,
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  position_json TEXT NOT NULL DEFAULT '{}',
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ebook_id, user_id)
);
