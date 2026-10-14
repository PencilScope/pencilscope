PRAGMA foreign_keys = ON;

CREATE TABLE creator_library_folders (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_user_id, name)
);

CREATE TABLE creator_library_items (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES creator_library_folders(id) ON DELETE SET NULL,
  media_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('file', 'link', 'note')),
  media_type TEXT NOT NULL CHECK (media_type IN ('video', 'audio', 'image', 'document', 'link', 'note')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  original_filename TEXT,
  source_url TEXT,
  note_text TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX creator_library_items_owner_idx
  ON creator_library_items(owner_user_id, status, media_type, updated_at);
CREATE INDEX creator_library_items_folder_idx
  ON creator_library_items(folder_id, status, updated_at);

CREATE TABLE creator_library_usages (
  item_id TEXT NOT NULL REFERENCES creator_library_items(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('course', 'learning_product', 'lesson', 'material')),
  entity_id TEXT NOT NULL,
  usage_label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, entity_type, entity_id)
);

CREATE INDEX creator_library_usages_entity_idx
  ON creator_library_usages(entity_type, entity_id);
