PRAGMA foreign_keys = ON;

CREATE TABLE course_invitations (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  course_offering_id TEXT NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  inviter_user_id TEXT NOT NULL REFERENCES users(id),
  recipient_email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  personal_message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'opened', 'registered', 'converted', 'expired', 'revoked')),
  delivery_status TEXT NOT NULL DEFAULT 'queued'
    CHECK (delivery_status IN ('queued', 'sent', 'failed')),
  provider_message_id TEXT,
  expires_at TEXT NOT NULL,
  opened_at TEXT,
  registered_user_id TEXT REFERENCES users(id),
  registered_at TEXT,
  converted_student_user_id TEXT REFERENCES users(id),
  converted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX course_invitations_creator_idx
  ON course_invitations(course_id, course_offering_id, created_at DESC);
CREATE INDEX course_invitations_recipient_idx
  ON course_invitations(recipient_email, status, expires_at);
