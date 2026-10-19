PRAGMA foreign_keys = ON;

CREATE TABLE contact_enquiries (
  id TEXT PRIMARY KEY,
  reference_code TEXT NOT NULL UNIQUE,
  submission_key TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  schema_version INTEGER NOT NULL DEFAULT 1,
  display_name TEXT NOT NULL,
  country_code TEXT NOT NULL,
  country_name TEXT NOT NULL,
  enquiry_type TEXT NOT NULL CHECK (enquiry_type IN (
    'general', 'learning_enrolment', 'creator_support', 'business_partnership',
    'technical_problem', 'billing', 'privacy_account', 'other'
  )),
  phone_last4 TEXT NOT NULL,
  source_path TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved', 'spam', 'deleted')),
  assigned_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  deleted_at TEXT,
  recoverable_until TEXT,
  purged_at TEXT
);

CREATE INDEX idx_contact_enquiries_status_created
  ON contact_enquiries(status, created_at DESC);
CREATE INDEX idx_contact_enquiries_type_country
  ON contact_enquiries(enquiry_type, country_code, created_at DESC);
CREATE INDEX idx_contact_enquiries_recovery
  ON contact_enquiries(recoverable_until) WHERE status = 'deleted' AND purged_at IS NULL;

CREATE TABLE contact_enquiry_notes (
  id TEXT PRIMARY KEY,
  enquiry_id TEXT NOT NULL REFERENCES contact_enquiries(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_contact_enquiry_notes_enquiry
  ON contact_enquiry_notes(enquiry_id, created_at DESC);
