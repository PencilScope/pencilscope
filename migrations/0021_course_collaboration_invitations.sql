PRAGMA foreign_keys = ON;

ALTER TABLE course_member_invitations ADD COLUMN personal_message TEXT NOT NULL DEFAULT '';
ALTER TABLE course_member_invitations ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'queued'
  CHECK (delivery_status IN ('queued', 'sent', 'failed'));
ALTER TABLE course_member_invitations ADD COLUMN provider_message_id TEXT;

CREATE INDEX course_member_invites_email_idx
  ON course_member_invitations(email, status, expires_at);
