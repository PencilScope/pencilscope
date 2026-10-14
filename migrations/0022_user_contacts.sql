PRAGMA foreign_keys = ON;

CREATE TABLE user_contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('mobile', 'email')),
  label TEXT NOT NULL DEFAULT 'Personal',
  contact_value TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, contact_type, contact_value)
);

CREATE INDEX user_contacts_user_idx ON user_contacts(user_id, contact_type, created_at);
CREATE UNIQUE INDEX user_contacts_primary_idx
  ON user_contacts(user_id, contact_type) WHERE is_primary = 1;

INSERT INTO user_contacts
  (id, user_id, contact_type, label, contact_value, is_primary, verified_at, created_at, updated_at)
SELECT lower(hex(randomblob(16))), ap.user_id, 'mobile', 'Personal', ap.phone_e164, 1, NULL,
  COALESCE(ap.created_at, CURRENT_TIMESTAMP), COALESCE(ap.updated_at, CURRENT_TIMESTAMP)
FROM account_profiles ap
WHERE ap.phone_e164 IS NOT NULL AND trim(ap.phone_e164) != '';
