PRAGMA foreign_keys = ON;

-- Question media is selected from the creator's Content Library and pinned to
-- the immutable asset version that was current when the question was saved.
CREATE TABLE assessment_question_media (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  library_item_id TEXT NOT NULL REFERENCES creator_library_items(id) ON DELETE RESTRICT,
  asset_version_id TEXT NOT NULL REFERENCES media_asset_versions(id) ON DELETE RESTRICT,
  course_question_id TEXT REFERENCES assessment_questions(id) ON DELETE CASCADE,
  learning_product_id TEXT REFERENCES learning_products(id) ON DELETE CASCADE,
  standalone_question_id TEXT,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video', 'audio')),
  alt_text TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (course_question_id IS NOT NULL AND learning_product_id IS NULL AND standalone_question_id IS NULL)
    OR
    (course_question_id IS NULL AND learning_product_id IS NOT NULL AND standalone_question_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX assessment_question_media_course_idx
  ON assessment_question_media(course_question_id)
  WHERE course_question_id IS NOT NULL;

CREATE UNIQUE INDEX assessment_question_media_product_idx
  ON assessment_question_media(learning_product_id, standalone_question_id)
  WHERE learning_product_id IS NOT NULL;

CREATE INDEX assessment_question_media_library_idx
  ON assessment_question_media(library_item_id, asset_version_id);
