CREATE TABLE learning_products (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  product_type TEXT NOT NULL CHECK (
    product_type IN ('ebook', 'reading', 'quiz', 'test', 'mock_exam', 'video', 'audio')
  ),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  audience TEXT NOT NULL,
  content_url TEXT,
  content_json TEXT NOT NULL DEFAULT '{}',
  estimated_minutes INTEGER CHECK (estimated_minutes IS NULL OR estimated_minutes > 0),
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'SGD',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX learning_products_catalogue_idx
  ON learning_products(status, product_type, published_at);
CREATE INDEX learning_products_creator_idx
  ON learning_products(creator_id, updated_at);

CREATE TABLE learning_product_entitlements (
  id TEXT PRIMARY KEY,
  learning_product_id TEXT NOT NULL REFERENCES learning_products(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'revoked')),
  granted_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (learning_product_id, user_id)
);

CREATE INDEX learning_product_entitlements_user_idx
  ON learning_product_entitlements(user_id, status, granted_at);

CREATE TABLE learning_product_attempts (
  id TEXT PRIMARY KEY,
  learning_product_id TEXT NOT NULL REFERENCES learning_products(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answers_json TEXT NOT NULL,
  score_percent INTEGER NOT NULL CHECK (score_percent BETWEEN 0 AND 100),
  passed INTEGER NOT NULL DEFAULT 0 CHECK (passed IN (0, 1)),
  submitted_at TEXT NOT NULL
);

CREATE INDEX learning_product_attempts_user_idx
  ON learning_product_attempts(user_id, learning_product_id, submitted_at);

CREATE TABLE course_offering_learning_products (
  course_offering_id TEXT NOT NULL REFERENCES course_offerings(id) ON DELETE CASCADE,
  learning_product_id TEXT NOT NULL REFERENCES learning_products(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 1,
  release_at TEXT,
  PRIMARY KEY (course_offering_id, learning_product_id)
);
