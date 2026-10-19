PRAGMA foreign_keys = ON;

CREATE TABLE product_offers (
  id TEXT PRIMARY KEY,
  creator_user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'SGD',
  pricing_version INTEGER NOT NULL DEFAULT 1,
  stripe_product_id TEXT,
  stripe_price_id TEXT,
  pricing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (pricing_status IN ('pending', 'syncing', 'ready', 'failed')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'closed', 'archived')),
  enrolment_opens_at TEXT,
  enrolment_closes_at TEXT,
  access_ends_at TEXT,
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  commerce_course_id TEXT NOT NULL UNIQUE REFERENCES courses(id) ON DELETE CASCADE,
  commerce_offering_id TEXT NOT NULL UNIQUE REFERENCES course_offerings(id) ON DELETE CASCADE,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX product_offers_creator_idx ON product_offers(creator_user_id, status, updated_at);
CREATE INDEX product_offers_catalogue_idx ON product_offers(status, pricing_status, enrolment_opens_at, enrolment_closes_at);

CREATE TABLE product_offer_items (
  product_offer_id TEXT NOT NULL REFERENCES product_offers(id) ON DELETE CASCADE,
  learning_product_id TEXT NOT NULL REFERENCES learning_products(id),
  position INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (product_offer_id, learning_product_id)
);
CREATE INDEX product_offer_items_product_idx ON product_offer_items(learning_product_id, product_offer_id);

CREATE TABLE product_offer_prices (
  id TEXT PRIMARY KEY,
  product_offer_id TEXT NOT NULL REFERENCES product_offers(id) ON DELETE CASCADE,
  stripe_price_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL,
  pricing_version INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE(product_offer_id, pricing_version)
);
CREATE INDEX product_offer_prices_current_idx ON product_offer_prices(product_offer_id, active);
