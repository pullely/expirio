-- 200_expiry_core
-- Expiry persistence foundation — tracked items and their materialised reminder ladder
-- Bounded context: expiry
-- schema expiry: Expiry bounded context — owns the tracked item (a licence, permit,
-- policy or certification) and the escalating reminder rows scheduled against its
-- expiry date. A cirrus project is the LOCATION an item belongs to; there is no
-- second tenancy axis.

CREATE TABLE IF NOT EXISTS expiry_items (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  project_id    TEXT,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'license'
                CHECK (kind IN ('license','permit','insurance','certification','registration','domain','ssl','other')),
  template_key  TEXT,
  issuer        TEXT,
  identifier    TEXT,
  holder_name   TEXT,
  holder_email  TEXT,
  manager_email TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','expiring','expired','renewed','archived')),
  issued_on     TEXT,
  expires_on    TEXT NOT NULL,
  notes         TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at   TEXT
);

-- table expiry_items: One tracked thing that expires. Every query must scope by org_id.
-- column expiry_items.org_id: Owning organization — opaque reference, no cross-context FK.
-- column expiry_items.project_id: Owning location (a cirrus project), NULL = organization-wide.
-- column expiry_items.expires_on: ISO date. The clock the whole product is built on.
-- column expiry_items.identifier: The licence or policy number, entered by hand. Never sent in an email.

CREATE INDEX IF NOT EXISTS idx_expiry_items_org_created
  ON expiry_items (org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_expiry_items_org_expires
  ON expiry_items (org_id, expires_on);

CREATE INDEX IF NOT EXISTS idx_expiry_items_org_project
  ON expiry_items (org_id, project_id);

CREATE INDEX IF NOT EXISTS idx_expiry_items_due
  ON expiry_items (status, expires_on);

CREATE TABLE IF NOT EXISTS expiry_reminders (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  item_id         TEXT NOT NULL REFERENCES expiry_items (id) ON DELETE CASCADE,
  offset_days     INTEGER NOT NULL,
  tier            TEXT NOT NULL CHECK (tier IN ('holder','manager','owner')),
  scheduled_for   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','skipped','failed')),
  recipient       TEXT,
  notification_id TEXT,
  sent_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- table expiry_reminders: The materialised escalation ladder for one item. Rows are
-- written when the item is created or its expiry date moves, never derived at send
-- time — "have we already chased this?" is a database fact, not a cron's memory.
-- column expiry_reminders.offset_days: Days before expires_on. 90, 60, 30, 7 and 0.
-- column expiry_reminders.tier: Who is chased at this rung — the holder, their manager, then the owner.

CREATE UNIQUE INDEX IF NOT EXISTS idx_expiry_reminders_item_offset
  ON expiry_reminders (item_id, offset_days);

CREATE INDEX IF NOT EXISTS idx_expiry_reminders_due
  ON expiry_reminders (status, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_expiry_reminders_org_item
  ON expiry_reminders (org_id, item_id);
