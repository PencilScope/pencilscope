ALTER TABLE course_materials ADD COLUMN resource_kind TEXT NOT NULL DEFAULT 'resource'
  CHECK (resource_kind IN ('resource', 'ebook', 'worksheet', 'slides', 'reference'));
