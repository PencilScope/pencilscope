ALTER TABLE courses ADD COLUMN stripe_product_id TEXT;
ALTER TABLE courses ADD COLUMN pricing_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (pricing_status IN ('pending', 'syncing', 'ready', 'failed'));
ALTER TABLE courses ADD COLUMN pricing_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE orders ADD COLUMN stripe_price_id TEXT;

CREATE TABLE course_prices (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  stripe_price_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL,
  billing_type TEXT NOT NULL CHECK (billing_type IN ('one_time', 'recurring')),
  billing_interval TEXT,
  pricing_version INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE(course_id, pricing_version)
);

CREATE INDEX course_prices_current_idx ON course_prices(course_id, active);

