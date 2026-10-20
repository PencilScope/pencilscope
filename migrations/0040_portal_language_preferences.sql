ALTER TABLE account_profiles ADD COLUMN preferred_locale TEXT NOT NULL DEFAULT 'en'
  CHECK (preferred_locale IN ('en', 'zh-SG', 'ms', 'ta'));

CREATE INDEX account_profiles_preferred_locale_idx
  ON account_profiles(preferred_locale);
