ALTER TABLE course_materials ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'resource'
  CHECK (content_kind IN ('resource', 'ebook', 'reading', 'video', 'audio'));

UPDATE course_materials SET content_kind = CASE
  WHEN resource_kind = 'ebook' THEN 'ebook'
  WHEN resource_kind IN ('reference', 'worksheet', 'slides') THEN 'reading'
  WHEN material_type = 'video' THEN 'video'
  ELSE 'resource'
END;
