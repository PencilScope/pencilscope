PRAGMA foreign_keys = ON;

CREATE TABLE creator_library_multipart_uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reservation_id TEXT NOT NULL,
  r2_upload_id TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('video', 'audio', 'image', 'document')),
  total_bytes INTEGER NOT NULL CHECK (total_bytes > 0),
  part_size_bytes INTEGER NOT NULL CHECK (part_size_bytes >= 5242880),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  folder_id TEXT REFERENCES creator_library_folders(id) ON DELETE SET NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'completing', 'completed', 'aborted', 'expired', 'failed')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX creator_library_multipart_uploads_user_idx
  ON creator_library_multipart_uploads(user_id, status, updated_at);

CREATE TABLE creator_library_multipart_parts (
  upload_id TEXT NOT NULL REFERENCES creator_library_multipart_uploads(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (upload_id, part_number)
);
