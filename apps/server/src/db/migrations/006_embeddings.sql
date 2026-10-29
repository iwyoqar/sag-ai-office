-- Vector embeddings per knowledge chunk (semantic search). Stored as little-endian Float32 bytes.
-- PostgreSQL port: pgvector column + ivfflat/hnsw index.
CREATE TABLE knowledge_embeddings (
  chunk_id   TEXT PRIMARY KEY REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  created_at TEXT NOT NULL
);
