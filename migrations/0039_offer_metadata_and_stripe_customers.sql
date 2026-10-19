PRAGMA foreign_keys = ON;

ALTER TABLE learning_products ADD COLUMN language_code TEXT NOT NULL DEFAULT 'en';
ALTER TABLE courses ADD COLUMN language_code TEXT NOT NULL DEFAULT 'en';
ALTER TABLE product_offer_items ADD COLUMN content_version INTEGER;
ALTER TABLE product_offer_course_items ADD COLUMN content_version INTEGER;

UPDATE product_offer_items
SET content_version = (SELECT content_version FROM learning_products p WHERE p.id = learning_product_id)
WHERE content_version IS NULL;

UPDATE product_offer_course_items
SET content_version = (SELECT content_version FROM courses c WHERE c.id = course_id)
WHERE content_version IS NULL;

CREATE TABLE stripe_customers (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO stripe_customers (user_id, stripe_customer_id, email, created_at, updated_at)
SELECT s.user_id, s.stripe_customer_id, u.email, s.created_at, s.updated_at
FROM creator_storage_subscriptions s JOIN users u ON u.id = s.user_id
WHERE s.stripe_customer_id IS NOT NULL;

CREATE INDEX stripe_customers_email_idx ON stripe_customers(email);
