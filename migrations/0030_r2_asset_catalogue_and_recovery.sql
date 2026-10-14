PRAGMA foreign_keys = ON;

-- D1 remains the queryable catalogue. R2 object keys are immutable payload locations.
CREATE TABLE r2_asset_objects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket_binding TEXT NOT NULL DEFAULT 'MEDIA',
  object_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mime_type TEXT,
  etag TEXT,
  checksum_sha256 TEXT,
  storage_class TEXT NOT NULL DEFAULT 'Standard',
  created_at TEXT NOT NULL,
  purge_after TEXT,
  purged_at TEXT
);

CREATE INDEX r2_asset_objects_owner_retention_idx
  ON r2_asset_objects(owner_user_id, purged_at, purge_after, created_at);

CREATE TABLE media_asset_versions (
  id TEXT PRIMARY KEY,
  media_asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  object_id TEXT NOT NULL REFERENCES r2_asset_objects(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  original_filename TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(media_asset_id, version_number)
);

CREATE INDEX media_asset_versions_asset_idx
  ON media_asset_versions(media_asset_id, version_number DESC);
CREATE INDEX media_asset_versions_object_idx
  ON media_asset_versions(object_id);

ALTER TABLE media_assets ADD COLUMN current_version_id TEXT REFERENCES media_asset_versions(id);
ALTER TABLE creator_library_items ADD COLUMN deleted_at TEXT;
ALTER TABLE creator_library_items ADD COLUMN recoverable_until TEXT;
ALTER TABLE creator_library_items ADD COLUMN purged_at TEXT;
ALTER TABLE creator_library_multipart_uploads ADD COLUMN target_library_item_id TEXT REFERENCES creator_library_items(id) ON DELETE SET NULL;

-- Existing R2 assets become version 1 without copying or renaming their objects.
INSERT INTO r2_asset_objects
  (id, owner_user_id, bucket_binding, object_key, size_bytes, mime_type, created_at)
SELECT 'legacy-object-' || id, owner_user_id, 'MEDIA', storage_key,
       COALESCE(size_bytes, 0), mime_type, created_at
FROM media_assets
WHERE provider = 'r2' AND storage_key IS NOT NULL;

INSERT INTO media_asset_versions
  (id, media_asset_id, object_id, version_number, original_filename, created_by_user_id, created_at)
SELECT 'legacy-version-' || ma.id, ma.id, 'legacy-object-' || ma.id, 1,
       cli.original_filename, ma.owner_user_id, ma.created_at
FROM media_assets ma
LEFT JOIN creator_library_items cli ON cli.media_asset_id = ma.id
WHERE ma.provider = 'r2' AND ma.storage_key IS NOT NULL;

UPDATE media_assets
SET current_version_id = 'legacy-version-' || id
WHERE provider = 'r2' AND storage_key IS NOT NULL;

CREATE INDEX creator_library_recovery_idx
  ON creator_library_items(owner_user_id, status, recoverable_until, purged_at);
CREATE INDEX creator_library_multipart_target_idx
  ON creator_library_multipart_uploads(target_library_item_id, status, updated_at);
