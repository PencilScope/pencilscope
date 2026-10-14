PRAGMA foreign_keys = ON;

ALTER TABLE account_profiles ADD COLUMN country_code TEXT
  CHECK (country_code IS NULL OR length(country_code) = 2);
ALTER TABLE account_profiles ADD COLUMN phone_e164 TEXT
  CHECK (phone_e164 IS NULL OR (phone_e164 GLOB '+[0-9]*' AND length(phone_e164) BETWEEN 8 AND 16));
ALTER TABLE account_profiles ADD COLUMN phone_verified_at TEXT;

CREATE TABLE user_interest_categories (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES course_categories(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, category_id)
);
CREATE INDEX user_interest_categories_category_idx
  ON user_interest_categories(category_id, user_id);
