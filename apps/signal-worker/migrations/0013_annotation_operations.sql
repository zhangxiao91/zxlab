CREATE TABLE annotation_operations (
  key_hash TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'succeeded', 'failed')),
  annotation_id TEXT REFERENCES annotations(id),
  lease_token TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_annotation_operations_status ON annotation_operations(status, updated_at DESC);

ALTER TABLE annotations ADD COLUMN operation_key_hash TEXT;
CREATE UNIQUE INDEX idx_annotations_operation_key ON annotations(operation_key_hash) WHERE operation_key_hash IS NOT NULL;
