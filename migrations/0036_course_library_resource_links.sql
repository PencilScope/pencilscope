PRAGMA foreign_keys = ON;

CREATE TABLE creator_library_resource_links_new (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES creator_library_items(id) ON DELETE RESTRICT,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('course', 'learning_product', 'lesson', 'ebook', 'ebook_chapter')),
  entity_id TEXT NOT NULL,
  resource_role TEXT NOT NULL CHECK (resource_role IN ('primary_media', 'primary_document', 'lesson_media', 'cover', 'chapter_reference', 'transcript', 'captions', 'supplement')),
  position INTEGER NOT NULL DEFAULT 1 CHECK (position > 0),
  required_percent INTEGER NOT NULL DEFAULT 90 CHECK (required_percent BETWEEN 1 AND 100),
  created_at TEXT NOT NULL,
  UNIQUE(item_id, entity_type, entity_id, resource_role)
);

INSERT INTO creator_library_resource_links_new
  (id, item_id, owner_user_id, entity_type, entity_id, resource_role, position, required_percent, created_at)
SELECT id, item_id, owner_user_id, entity_type, entity_id, resource_role, position, required_percent, created_at
FROM creator_library_resource_links;

DROP TABLE creator_library_resource_links;
ALTER TABLE creator_library_resource_links_new RENAME TO creator_library_resource_links;

CREATE INDEX creator_library_resource_links_entity_idx
  ON creator_library_resource_links(entity_type, entity_id, resource_role, position);
CREATE INDEX creator_library_resource_links_item_idx
  ON creator_library_resource_links(item_id, created_at);