PRAGMA foreign_keys = ON;

ALTER TABLE courses ADD COLUMN creator_price_cents INTEGER NOT NULL DEFAULT 0;
UPDATE courses SET creator_price_cents = price_cents WHERE creator_price_cents = 0;

ALTER TABLE course_offerings ADD COLUMN creator_price_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE course_offerings ADD COLUMN platform_fixed_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE course_offerings ADD COLUMN service_fee_bps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE course_offerings ADD COLUMN service_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE course_offerings ADD COLUMN planned_meeting_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE course_offerings ADD COLUMN planned_meeting_participants INTEGER NOT NULL DEFAULT 0;
ALTER TABLE course_offerings ADD COLUMN planned_paid_learners INTEGER NOT NULL DEFAULT 1;
ALTER TABLE course_offerings ADD COLUMN planned_meeting_cost_cents INTEGER NOT NULL DEFAULT 0;
UPDATE course_offerings SET creator_price_cents = price_cents WHERE creator_price_cents = 0;

ALTER TABLE offering_settlement_policies ADD COLUMN platform_fixed_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE offering_settlement_policies ADD COLUMN planned_meeting_budget_cents INTEGER NOT NULL DEFAULT 0;

ALTER TABLE course_sessions ADD COLUMN google_calendar_event_id TEXT;
ALTER TABLE course_sessions ADD COLUMN google_meet_code TEXT;
ALTER TABLE course_sessions ADD COLUMN google_meet_space_name TEXT;
CREATE UNIQUE INDEX course_sessions_google_event_idx ON course_sessions(google_calendar_event_id);

CREATE TABLE google_integrations (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  google_email TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  token_expires_at TEXT NOT NULL,
  scopes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE session_reminder_deliveries (
  session_id TEXT NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reminder_minutes INTEGER NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (session_id, user_id, reminder_minutes)
);
CREATE INDEX session_reminders_delivered_idx
  ON session_reminder_deliveries(delivered_at, reminder_minutes);
