PRAGMA foreign_keys = ON;

CREATE TABLE course_categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE course_category_links (
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES course_categories(id),
  PRIMARY KEY (course_id, category_id)
);

CREATE TABLE course_members (
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  member_role TEXT NOT NULL CHECK (member_role IN ('owner', 'administrator', 'instructor', 'facilitator', 'editor')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (course_id, user_id)
);
CREATE INDEX course_members_user_idx ON course_members(user_id, status, member_role);

CREATE TABLE venues (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  address_line_1 TEXT NOT NULL,
  address_line_2 TEXT,
  city TEXT NOT NULL DEFAULT 'Singapore',
  postal_code TEXT,
  country_code TEXT NOT NULL DEFAULT 'SG',
  arrival_instructions TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE course_offerings ADD COLUMN offering_type TEXT NOT NULL DEFAULT 'academic_term'
  CHECK (offering_type IN ('self_paced', 'cohort', 'event', 'academic_term'));
ALTER TABLE course_offerings ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'hybrid'
  CHECK (delivery_mode IN ('recorded', 'live_online', 'in_person', 'hybrid'));
ALTER TABLE course_offerings ADD COLUMN starts_at TEXT;
ALTER TABLE course_offerings ADD COLUMN ends_at TEXT;
ALTER TABLE course_offerings ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Singapore';
ALTER TABLE course_offerings ADD COLUMN capacity INTEGER CHECK (capacity IS NULL OR capacity > 0);
ALTER TABLE course_offerings ADD COLUMN venue_id TEXT REFERENCES venues(id);
CREATE INDEX course_offerings_schedule_idx ON course_offerings(status, offering_type, starts_at, ends_at);

CREATE TABLE course_sessions (
  id TEXT PRIMARY KEY,
  course_offering_id TEXT NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  instructor_user_id TEXT REFERENCES users(id),
  title TEXT NOT NULL,
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('live_online', 'in_person')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Singapore',
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  meeting_url TEXT,
  meeting_provider TEXT,
  venue_id TEXT REFERENCES venues(id),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((delivery_mode = 'live_online' AND meeting_url IS NOT NULL)
    OR (delivery_mode = 'in_person' AND venue_id IS NOT NULL))
);
CREATE INDEX course_sessions_offering_idx ON course_sessions(course_offering_id, starts_at, status);

CREATE TABLE course_session_attendance (
  course_session_id TEXT NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE,
  student_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'attended', 'absent', 'cancelled')),
  checked_in_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (course_session_id, student_user_id)
);

ALTER TABLE lessons ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'recorded'
  CHECK (delivery_mode IN ('recorded', 'live_online', 'in_person'));
ALTER TABLE lessons ADD COLUMN course_session_id TEXT REFERENCES course_sessions(id);

INSERT INTO course_categories (id, slug, title, description, position, active, created_at) VALUES
  ('category-academic', 'academic', 'Academic', 'Curriculum and examination-focused learning.', 1, 1, datetime('now')),
  ('category-enrichment', 'enrichment', 'Enrichment', 'Skills and interests beyond the core curriculum.', 2, 1, datetime('now')),
  ('category-personal-development', 'personal-development', 'Personal development', 'Confidence, communication and personal growth.', 3, 1, datetime('now')),
  ('category-professional-development', 'professional-development', 'Professional development', 'Career and workplace learning.', 4, 1, datetime('now')),
  ('category-masterclass', 'masterclass', 'Masterclass', 'Focused instruction from an experienced practitioner.', 5, 1, datetime('now')),
  ('category-knowledge-sharing', 'knowledge-sharing', 'Knowledge sharing', 'Community and peer-led knowledge exchange.', 6, 1, datetime('now')),
  ('category-seminar', 'seminar', 'Seminar', 'Talks, discussions and expert presentations.', 7, 1, datetime('now')),
  ('category-workshop', 'workshop', 'Workshop', 'Hands-on, participatory learning.', 8, 1, datetime('now')),
  ('category-coaching', 'coaching', 'Coaching', 'Guided individual or group development.', 9, 1, datetime('now')),
  ('category-certification', 'certification-preparation', 'Certification preparation', 'Preparation for professional or academic certification.', 10, 1, datetime('now'));

INSERT OR IGNORE INTO course_members (course_id, user_id, member_role, status, created_at, updated_at)
SELECT id, tutor_id, 'owner', 'active', created_at, updated_at FROM courses WHERE tutor_id IS NOT NULL;

INSERT OR IGNORE INTO course_category_links (course_id, category_id)
SELECT id, 'category-academic' FROM courses;

UPDATE lessons SET delivery_mode = CASE lesson_type WHEN 'live' THEN 'live_online' ELSE 'recorded' END;

UPDATE course_offerings SET
  offering_type = CASE WHEN academic_term_id = 'academic-term-legacy' THEN 'self_paced' ELSE 'academic_term' END,
  delivery_mode = CASE
    WHEN (SELECT delivery_mode FROM courses WHERE courses.id = course_offerings.course_id) = 'live' THEN 'live_online'
    WHEN (SELECT delivery_mode FROM courses WHERE courses.id = course_offerings.course_id) = 'self-paced' THEN 'recorded'
    ELSE 'hybrid'
  END,
  starts_at = (SELECT starts_at FROM academic_terms WHERE academic_terms.id = course_offerings.academic_term_id),
  ends_at = (SELECT ends_at FROM academic_terms WHERE academic_terms.id = course_offerings.academic_term_id);
