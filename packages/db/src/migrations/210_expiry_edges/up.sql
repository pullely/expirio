-- 210_expiry_edges
-- Expiry's open edges (EX3) — documents in R2, the no-account renewal link, the ICS feed token
-- Bounded context: expiry
-- The two public surfaces (renewal link, calendar feed) are opaque bearer tokens
-- stored ONLY as their SHA-256 hash; expiry-worker hashes what it is handed and
-- looks the row up. The raw token exists once, in the response that minted it.

CREATE TABLE IF NOT EXISTS expiry_documents (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  item_id       TEXT NOT NULL REFERENCES expiry_items (id) ON DELETE CASCADE,
  r2_key        TEXT NOT NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'console' CHECK (source IN ('console','renewal_link')),
  uploaded_by   TEXT,
  uploaded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table expiry_documents: A certificate scan or PDF attached to an item. The bytes live in R2
-- under r2_key = <org_uuid>/<item_uuid>/<document_uuid>; the tenant is in the key.
-- column expiry_documents.uploaded_by: The actor, NULL when uploaded through a renewal link.

CREATE UNIQUE INDEX IF NOT EXISTS idx_expiry_documents_r2_key
  ON expiry_documents (r2_key);

CREATE INDEX IF NOT EXISTS idx_expiry_documents_org_item
  ON expiry_documents (org_id, item_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS expiry_renewal_links (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  item_id       TEXT NOT NULL REFERENCES expiry_items (id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  created_by    TEXT,
  expires_at    TEXT NOT NULL,
  consumed_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table expiry_renewal_links: A single-use, 14-day link a holder renews an item from without an
-- account. consumed_at is the single use: the consuming UPDATE is predicated on it being NULL.

CREATE UNIQUE INDEX IF NOT EXISTS idx_expiry_renewal_links_token
  ON expiry_renewal_links (token_hash);

CREATE INDEX IF NOT EXISTS idx_expiry_renewal_links_org_item
  ON expiry_renewal_links (org_id, item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS expiry_feed_tokens (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  project_id    TEXT,
  label         TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  created_by    TEXT,
  revoked_at    TEXT,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table expiry_feed_tokens: A long-lived, revocable, read-only calendar subscription for one
-- location (project_id) or the whole organization (NULL). The feed carries name, kind and date only.

CREATE UNIQUE INDEX IF NOT EXISTS idx_expiry_feed_tokens_token
  ON expiry_feed_tokens (token_hash);

CREATE INDEX IF NOT EXISTS idx_expiry_feed_tokens_org
  ON expiry_feed_tokens (org_id, created_at DESC);
