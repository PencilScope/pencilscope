PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN avatar_asset_id TEXT REFERENCES media_assets(id);
ALTER TABLE courses ADD COLUMN cover_asset_id TEXT REFERENCES media_assets(id);
ALTER TABLE media_assets ADD COLUMN usage_kind TEXT
  CHECK (usage_kind IS NULL OR usage_kind IN ('user_avatar', 'course_cover'));

CREATE INDEX users_avatar_asset_idx ON users(avatar_asset_id);
CREATE INDEX courses_cover_asset_idx ON courses(cover_asset_id);
CREATE INDEX media_assets_usage_idx ON media_assets(usage_kind, status, updated_at);
