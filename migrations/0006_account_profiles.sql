PRAGMA foreign_keys = ON;

CREATE TABLE account_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_type TEXT NOT NULL CHECK (account_type IN ('individual', 'organization')),
  organization_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (account_type = 'individual' OR length(organization_name) >= 2)
);
CREATE INDEX account_profiles_type_idx ON account_profiles(account_type);

CREATE TABLE creator_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_name TEXT NOT NULL,
  biography TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'verified', 'suspended')),
  payout_status TEXT NOT NULL DEFAULT 'not_configured'
    CHECK (payout_status IN ('not_configured', 'pending', 'ready', 'restricted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO account_profiles
  (user_id, account_type, organization_name, created_at, updated_at)
SELECT id, 'individual', NULL, created_at, updated_at FROM users;

INSERT OR IGNORE INTO creator_profiles
  (user_id, public_name, biography, verification_status, payout_status, created_at, updated_at)
SELECT DISTINCT u.id, u.display_name, COALESCE(tp.biography, ''),
  CASE WHEN tp.verification_status = 'approved' THEN 'verified' ELSE 'unverified' END,
  CASE WHEN tp.stripe_account_id IS NOT NULL THEN 'pending' ELSE 'not_configured' END,
  u.created_at, u.updated_at
FROM users u
LEFT JOIN tutor_profiles tp ON tp.user_id = u.id
WHERE EXISTS (SELECT 1 FROM course_members cm WHERE cm.user_id = u.id AND cm.status = 'active')
   OR u.role IN ('tutor', 'admin');
