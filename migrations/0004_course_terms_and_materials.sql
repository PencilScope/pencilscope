PRAGMA foreign_keys = ON;

CREATE TABLE academic_terms (
  id TEXT PRIMARY KEY,
  academic_year INTEGER NOT NULL,
  term_number INTEGER NOT NULL CHECK (term_number BETWEEN 0 AND 12),
  title TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(academic_year, term_number)
);

CREATE TABLE course_offerings (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  academic_term_id TEXT NOT NULL REFERENCES academic_terms(id),
  title TEXT NOT NULL,
  enrolment_opens_at TEXT,
  enrolment_closes_at TEXT,
  access_ends_at TEXT,
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'SGD',
  pricing_version INTEGER NOT NULL DEFAULT 1,
  stripe_price_id TEXT,
  pricing_status TEXT NOT NULL DEFAULT 'pending' CHECK (pricing_status IN ('pending', 'syncing', 'ready', 'failed')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(course_id, academic_term_id)
);
CREATE INDEX course_offerings_catalogue_idx ON course_offerings(course_id, status, academic_term_id);

CREATE TABLE course_offering_prices (
  id TEXT PRIMARY KEY,
  course_offering_id TEXT NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  stripe_price_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL,
  pricing_version INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE(course_offering_id, pricing_version)
);
CREATE INDEX course_offering_prices_current_idx ON course_offering_prices(course_offering_id, active);

CREATE TABLE course_offering_modules (
  course_offering_id TEXT NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 1,
  release_at TEXT,
  PRIMARY KEY (course_offering_id, module_id)
);

CREATE TABLE course_materials (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  material_type TEXT NOT NULL CHECK (material_type IN ('document', 'video', 'link', 'download')),
  storage_key TEXT,
  external_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (storage_key IS NOT NULL OR external_url IS NOT NULL)
);

CREATE TABLE course_offering_materials (
  course_offering_id TEXT NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES course_materials(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 1,
  release_at TEXT,
  PRIMARY KEY (course_offering_id, material_id)
);

CREATE TABLE course_offering_assessments (
  course_offering_id TEXT NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 1,
  release_at TEXT,
  PRIMARY KEY (course_offering_id, assessment_id)
);

CREATE TABLE course_offering_flashcard_decks (
  course_offering_id TEXT NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL REFERENCES flashcard_decks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 1,
  release_at TEXT,
  PRIMARY KEY (course_offering_id, deck_id)
);

CREATE TABLE enrolment_offerings (
  id TEXT PRIMARY KEY,
  enrolment_id TEXT NOT NULL REFERENCES enrolments(id) ON DELETE CASCADE,
  course_offering_id TEXT NOT NULL REFERENCES course_offerings(id),
  student_user_id TEXT NOT NULL REFERENCES users(id),
  order_id TEXT REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled', 'expired')),
  enrolled_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(course_offering_id, student_user_id)
);
CREATE INDEX enrolment_offerings_student_idx ON enrolment_offerings(student_user_id, status, course_offering_id);

ALTER TABLE orders ADD COLUMN course_offering_id TEXT REFERENCES course_offerings(id);

INSERT OR IGNORE INTO academic_terms (id, academic_year, term_number, title, starts_at, ends_at, created_at)
VALUES ('academic-term-legacy', 2000, 0, 'Full course access', NULL, NULL, datetime('now'));

INSERT OR IGNORE INTO course_offerings
  (id, course_id, academic_term_id, title, price_cents, currency, pricing_version, stripe_price_id, pricing_status, status, created_at, updated_at)
SELECT 'offering-' || c.id, c.id, 'academic-term-legacy', 'Full course access',
  c.price_cents, c.currency, c.pricing_version, c.stripe_price_id, c.pricing_status,
  CASE WHEN c.status = 'published' THEN 'published' ELSE 'draft' END, c.created_at, c.updated_at
FROM courses c;

INSERT OR IGNORE INTO course_offering_prices
  (id, course_offering_id, stripe_price_id, amount_cents, currency, pricing_version, active, created_at)
SELECT 'offering-price-' || cp.id, 'offering-' || cp.course_id, cp.stripe_price_id,
  cp.amount_cents, cp.currency, cp.pricing_version, cp.active, cp.created_at
FROM course_prices cp;

INSERT OR IGNORE INTO course_offering_prices
  (id, course_offering_id, stripe_price_id, amount_cents, currency, pricing_version, active, created_at)
SELECT 'offering-current-' || c.id, 'offering-' || c.id, c.stripe_price_id,
  c.price_cents, c.currency, c.pricing_version, 1, c.updated_at
FROM courses c
WHERE c.stripe_price_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM course_offering_prices p
    WHERE p.course_offering_id = 'offering-' || c.id AND p.pricing_version = c.pricing_version
  );

INSERT OR IGNORE INTO course_offering_modules (course_offering_id, module_id, position)
SELECT 'offering-' || course_id, id, position FROM course_modules;

INSERT OR IGNORE INTO course_offering_assessments (course_offering_id, assessment_id, position)
SELECT 'offering-' || course_id, id, ROW_NUMBER() OVER (PARTITION BY course_id ORDER BY created_at)
FROM assessments;

INSERT OR IGNORE INTO course_offering_flashcard_decks (course_offering_id, deck_id, position)
SELECT 'offering-' || course_id, id, ROW_NUMBER() OVER (PARTITION BY course_id ORDER BY created_at)
FROM flashcard_decks;

INSERT OR IGNORE INTO enrolment_offerings
  (id, enrolment_id, course_offering_id, student_user_id, order_id, status, enrolled_at, completed_at)
SELECT 'enrolment-offering-' || e.id, e.id, 'offering-' || e.course_id,
  e.student_user_id, e.order_id, e.status, e.enrolled_at, e.completed_at
FROM enrolments e;

UPDATE orders SET course_offering_id = 'offering-' || course_id WHERE course_offering_id IS NULL;
