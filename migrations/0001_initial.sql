PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('parent', 'student', 'tutor', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE parent_student_relationships (
  parent_user_id TEXT NOT NULL REFERENCES users(id),
  student_user_id TEXT NOT NULL REFERENCES users(id),
  relationship TEXT NOT NULL DEFAULT 'guardian',
  permissions_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (parent_user_id, student_user_id)
);

CREATE TABLE tutor_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  display_name TEXT NOT NULL,
  biography TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'approved', 'rejected', 'suspended')),
  stripe_account_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  tutor_id TEXT REFERENCES users(id),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  subject TEXT NOT NULL,
  primary_level TEXT NOT NULL,
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('self-paced', 'live', 'hybrid', 'ai-supported')),
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'SGD',
  stripe_price_id TEXT,
  accent TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'archived')),
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX courses_catalogue_idx ON courses(status, subject, primary_level, published_at);

CREATE TABLE course_modules (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE lessons (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  lesson_type TEXT NOT NULL CHECK (lesson_type IN ('video', 'text', 'document', 'quiz', 'live', 'ai')),
  content_json TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL,
  estimated_minutes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  parent_user_id TEXT REFERENCES users(id),
  student_user_id TEXT REFERENCES users(id),
  course_id TEXT NOT NULL REFERENCES courses(id),
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'refunded', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE enrolments (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  student_user_id TEXT NOT NULL REFERENCES users(id),
  order_id TEXT REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled', 'expired')),
  enrolled_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(course_id, student_user_id)
);

CREATE TABLE progress_records (
  id TEXT PRIMARY KEY,
  enrolment_id TEXT NOT NULL REFERENCES enrolments(id) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('not-started', 'started', 'completed')),
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(enrolment_id, lesson_id)
);

CREATE TABLE live_classes (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  tutor_id TEXT NOT NULL REFERENCES users(id),
  starts_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_at TEXT NOT NULL
);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  live_class_id TEXT NOT NULL REFERENCES live_classes(id),
  student_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'attended', 'absent', 'cancelled')),
  booked_at TEXT NOT NULL,
  UNIQUE(live_class_id, student_user_id)
);

CREATE TABLE certificates (
  id TEXT PRIMARY KEY,
  enrolment_id TEXT NOT NULL UNIQUE REFERENCES enrolments(id),
  verification_code TEXT NOT NULL UNIQUE,
  asset_key TEXT,
  issued_at TEXT NOT NULL
);

CREATE TABLE webhook_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'failed')),
  error_message TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'in-app')),
  template_key TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')),
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

INSERT INTO users (id, email, display_name, role, status, created_at, updated_at) VALUES
  ('tutor-tan', 'tan@example.invalid', 'Ms Tan', 'tutor', 'active', datetime('now'), datetime('now')),
  ('tutor-lim', 'lim@example.invalid', 'Mr Lim', 'tutor', 'active', datetime('now'), datetime('now')),
  ('tutor-koh', 'koh@example.invalid', 'Mrs Koh', 'tutor', 'active', datetime('now'), datetime('now'));

INSERT INTO tutor_profiles (user_id, display_name, biography, verification_status, created_at, updated_at) VALUES
  ('tutor-tan', 'Ms Tan', 'Primary mathematics educator', 'approved', datetime('now'), datetime('now')),
  ('tutor-lim', 'Mr Lim', 'Hands-on primary science educator', 'approved', datetime('now'), datetime('now')),
  ('tutor-koh', 'Mrs Koh', 'English language and conversation educator', 'approved', datetime('now'), datetime('now'));

INSERT INTO courses (id, tutor_id, slug, title, description, subject, primary_level, delivery_mode, price_cents, currency, accent, status, published_at, created_at, updated_at) VALUES
  ('course-maths-5', 'tutor-tan', 'primary-5-maths-mastery', 'Primary 5 Maths Mastery', 'Build confident problem-solving habits with visual models, guided practice and weekly checkpoints.', 'Mathematics', 'Primary 5', 'hybrid', 8900, 'SGD', 'lime', 'published', datetime('now'), datetime('now'), datetime('now')),
  ('course-science-4', 'tutor-lim', 'primary-4-science-lab', 'Primary 4 Science Lab', 'Turn core science topics into memorable experiments, diagrams and exam-ready explanations.', 'Science', 'Primary 4', 'live', 12000, 'SGD', 'blue', 'published', datetime('now'), datetime('now'), datetime('now')),
  ('course-english-3', 'tutor-koh', 'confident-english-conversations', 'Confident English Conversations', 'Friendly speaking practice with stories, role play and age-appropriate AI-guided revision.', 'English', 'Primary 3–4', 'ai-supported', 5900, 'SGD', 'coral', 'published', datetime('now'), datetime('now'), datetime('now'));
