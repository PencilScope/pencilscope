PRAGMA foreign_keys = ON;

ALTER TABLE courses ADD COLUMN source_course_id TEXT REFERENCES courses(id);
ALTER TABLE courses ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX courses_version_lineage_idx ON courses(source_course_id, content_version);

ALTER TABLE learning_products ADD COLUMN source_product_id TEXT REFERENCES learning_products(id);
ALTER TABLE learning_products ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE learning_products ADD COLUMN listing_status TEXT NOT NULL DEFAULT 'listed'
  CHECK (listing_status IN ('listed', 'unpublished'));
CREATE INDEX learning_products_version_lineage_idx
  ON learning_products(source_product_id, content_version);
CREATE INDEX learning_products_listing_idx
  ON learning_products(status, listing_status, product_type, published_at);

ALTER TABLE ebooks ADD COLUMN source_ebook_id TEXT REFERENCES ebooks(id);
ALTER TABLE ebooks ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX ebooks_version_lineage_idx ON ebooks(source_ebook_id, content_version);
