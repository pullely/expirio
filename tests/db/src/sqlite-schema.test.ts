import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqlExecutor, type D1Binding } from "@saas/db/d1";
import { createIdentityRepository } from "@saas/db/identity";
import { createMembershipRepository } from "@saas/db/membership";
import { createProjectsRepository } from "@saas/db/projects";
import { createMeteringRepository } from "@saas/db/metering";
import { createWebhookRepository } from "@saas/db/webhooks";
import { createEventsRepository } from "@saas/db/events";
import { createExpiryRepository } from "@saas/db/expiry";
import { asUuid } from "@saas/db";
import { D1ApiAdapter } from "@saas/db/runner";

// The runner's own statement splitter — the same one that will feed D1 over
// the REST API — so this suite exercises the production path, not a copy.
const splitStatements = D1ApiAdapter.splitStatements;

// The migrations and the repositories are checked against a REAL SQLite engine
// here, not a mock. Every other repository suite in this package stubs the
// executor and asserts the SQL text — necessary, but blind to whether SQLite
// would accept that text. This suite closes that gap: D1 is SQLite, so a
// statement `node:sqlite` parses and runs is a statement D1 runs.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

function migrationDirs(): string[] {
  return readdirSync(MIGRATIONS_ROOT)
    .filter((d) => existsSync(join(MIGRATIONS_ROOT, d, "up.sql")))
    .sort();
}

/** A D1 binding backed by an in-memory SQLite database. */
function d1Over(db: DatabaseSync): D1Binding {
  return {
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        all<T>() {
          const prepared = db.prepare(query);
          const rows = prepared.all(...(bound as never[])) as T[];
          return Promise.resolve({ results: rows, success: true });
        },
      };
      return statement;
    },
  } as unknown as D1Binding;
}

function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const dir of migrationDirs()) {
    const sql = readFileSync(join(MIGRATIONS_ROOT, dir, "up.sql"), "utf8");
    for (const statement of splitStatements(sql)) db.exec(statement);
  }
  return db;
}

describe("migrations against a real SQLite engine", () => {
  it("apply cleanly in manifest order", () => {
    expect(() => migratedDatabase()).not.toThrow();
  });

  it("are idempotent — a second application changes nothing", () => {
    const db = migratedDatabase();
    for (const dir of migrationDirs()) {
      const sql = readFileSync(join(MIGRATIONS_ROOT, dir, "up.sql"), "utf8");
      for (const statement of splitStatements(sql)) {
        try {
          db.exec(statement);
        } catch (err) {
          // SQLite has no `ADD COLUMN IF NOT EXISTS`; the runner's applied
          // ledger is what stops a column add from running twice. Every other
          // statement must be re-runnable on its own.
          expect(String(err)).toMatch(/duplicate column name/i);
        }
      }
    }
    db.close();
  });

  it("create every table the repositories address, with no schema prefixes left", () => {
    const db = migratedDatabase();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);

    expect(tables).toContain("identity_users");
    expect(tables).toContain("membership_organizations");
    expect(tables).toContain("_migrations_applied");
    // A dot in a table name would mean a Postgres schema survived the port.
    for (const name of tables) expect(name).not.toContain(".");
    db.close();
  });

  it("default timestamps to a parseable ISO-8601 instant", () => {
    // Postgres `now()` became a strftime format string; if that format were
    // wrong, `new Date(row.created_at)` in every row mapper would yield
    // Invalid Date — silently, and only at runtime.
    const db = migratedDatabase();
    db.exec(
      `INSERT INTO identity_users (id, email, email_lower) VALUES ('u1', 'a@b.c', 'a@b.c')`,
    );
    const row = db.prepare("SELECT created_at FROM identity_users").get() as {
      created_at: string;
    };
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(new Date(row.created_at).getTime())).toBe(false);
    db.close();
  });
});

describe("repositories against a real SQLite engine", () => {
  let db: DatabaseSync;
  let executor: ReturnType<typeof createSqlExecutor>;

  beforeEach(() => {
    db = migratedDatabase();
    executor = createSqlExecutor(d1Over(db));
  });

  afterEach(() => {
    db.close();
  });

  it("round-trips a user through create and read", async () => {
    const repo = createIdentityRepository(executor);
    const created = await repo.createUser({
      id: "11111111-1111-4111-8111-111111111111",
      email: "Ada@Example.com",
      emailLower: "ada@example.com",
      displayName: "Ada",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.email).toBe("Ada@Example.com");
    expect(created.value.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");

    const found = await repo.getUserByEmail("ada@example.com");
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value.id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("maps a real unique-constraint failure to a conflict result", async () => {
    // The dialect's own error, raised by the engine — not a hand-written
    // fixture. This is what makes isUniqueViolation's pattern trustworthy.
    const repo = createIdentityRepository(executor);
    const input = {
      id: "22222222-2222-4222-8222-222222222222",
      email: "dup@example.com",
      emailLower: "dup@example.com",
      displayName: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    expect((await repo.createUser(input)).ok).toBe(true);

    const again = await repo.createUser({
      ...input,
      id: "33333333-3333-4333-8333-333333333333",
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.kind).toBe("conflict");
  });

  it("round-trips an organization and its slug lookup", async () => {
    const repo = createMembershipRepository(executor);
    const created = await repo.createOrganization({
      id: "44444444-4444-4444-8444-444444444444",
      name: "Acme",
      slug: "acme",
      slugLower: "acme",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(created.ok).toBe(true);

    const bySlug = await repo.getOrganizationBySlug("acme");
    expect(bySlug.ok).toBe(true);
    if (bySlug.ok) expect(bySlug.value.name).toBe("Acme");
  });

  it("counts through the un-cast COUNT(*) the port left behind", async () => {
    // `COUNT(*)::bigint` was a Postgres cast; SQLite rejects it. This asserts
    // the replacement still returns a usable number through the mapper — the
    // value quota enforcement reads before allowing another project.
    const orgId = asUuid("55555555-5555-4555-8555-555555555555");
    const projects = createProjectsRepository(executor);

    const empty = await projects.countActiveProjects(orgId);
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value).toBe(0);

    const created = await projects.createProject({
      id: asUuid("66666666-6666-4666-8666-666666666666"),
      orgId,
      name: "First",
      slug: "first",
      slugLower: "first",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(created.ok).toBe(true);

    const counted = await projects.countActiveProjects(orgId);
    expect(counted.ok).toBe(true);
    if (counted.ok) expect(counted.value).toBe(1);
  });
});

// The three queries the port rewrote most, run for real. Each replaced a
// Postgres construct SQLite does not have (date_trunc, md5, INTERVAL, a
// timestamptz cast), and each is a place where a mock executor would happily
// assert the text of SQL that the engine rejects.
describe("the rewritten queries, against a real SQLite engine", () => {
  let db: DatabaseSync;
  let executor: ReturnType<typeof createSqlExecutor>;

  beforeEach(() => {
    db = migratedDatabase();
    executor = createSqlExecutor(d1Over(db));
  });

  afterEach(() => {
    db.close();
  });

  it("materializes usage rollups: strftime buckets, a key-derived id, and an upsert", async () => {
    const repo = createMeteringRepository(executor);
    const orgId = "org-roll";

    // Two records in the same hour, one in the next: the aggregation must fold
    // the first two together and keep the third separate.
    const at = async (iso: string, key: string, quantity: number) => {
      const r = await repo.recordUsage({
        id: `usage-${key}`,
        orgId,
        metric: "api_requests",
        quantity,
        idempotencyKey: key,
        recordedAt: new Date(iso),
      });
      expect(r.ok).toBe(true);
    };
    await at("2026-03-15T11:10:00.000Z", "a", 3);
    await at("2026-03-15T11:50:00.000Z", "b", 4);
    await at("2026-03-15T12:05:00.000Z", "c", 5);

    const first = await repo.materializeUsageRollups({
      bucketType: "hour",
      start: new Date("2026-03-15T11:00:00.000Z"),
      end: new Date("2026-03-15T13:00:00.000Z"),
    });
    expect(first.ok).toBe(true);

    const rows = db
      .prepare(
        "SELECT bucket_start, quantity, record_count FROM metering_usage_rollups ORDER BY bucket_start",
      )
      .all() as { bucket_start: string; quantity: number; record_count: number }[];
    expect(rows).toEqual([
      { bucket_start: "2026-03-15T11:00:00.000Z", quantity: 7, record_count: 2 },
      { bucket_start: "2026-03-15T12:00:00.000Z", quantity: 5, record_count: 1 },
    ]);

    // Re-materializing the same window must UPDATE, never duplicate — the
    // ON CONFLICT target has to match the unique index expression for expression.
    const again = await repo.materializeUsageRollups({
      bucketType: "hour",
      start: new Date("2026-03-15T11:00:00.000Z"),
      end: new Date("2026-03-15T13:00:00.000Z"),
    });
    expect(again.ok).toBe(true);
    const count = db.prepare("SELECT COUNT(*) AS n FROM metering_usage_rollups").get() as {
      n: number;
    };
    expect(count.n).toBe(2);
  });

  it("rotates a webhook secret with a grace window computed by strftime", async () => {
    const repo = createWebhookRepository(executor);
    const orgId = asUuid("77777777-7777-4777-8777-777777777777");
    const endpointId = "wep_rotate";

    const created = await repo.createEndpoint({
      id: endpointId,
      orgId,
      url: "https://example.test/hook",
      secretCiphertext: "envelope-v1",
    });
    expect(created.ok).toBe(true);

    const rotated = await repo.rotateEndpointSecret(orgId, endpointId, {
      secretCiphertext: "envelope-v2",
      gracePeriodSeconds: 3600,
    });
    expect(rotated.ok).toBe(true);

    const row = db
      .prepare(
        `SELECT previous_secret_ciphertext, previous_secret_version, previous_secret_expires_at
         FROM webhooks_webhook_endpoints WHERE id = ?`,
      )
      .get(endpointId) as {
      previous_secret_ciphertext: string;
      previous_secret_version: number;
      previous_secret_expires_at: string;
    };
    expect(row.previous_secret_ciphertext).toBe("envelope-v1");
    expect(row.previous_secret_version).toBe(1);
    // The INTERVAL literal became a strftime modifier; if the modifier were
    // malformed SQLite returns NULL rather than failing, so assert the shape.
    expect(row.previous_secret_expires_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(new Date(row.previous_secret_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("bootstraps an organization and accepts an invitation into it — the firm's two front doors", async () => {
    // chaseid CH3: both were single Postgres data-modifying CTEs with
    // row_to_json, which SQLite cannot parse — no org could be created on D1.
    const repo = createMembershipRepository(executor);
    const orgId = asUuid("77777777-7777-4777-8777-777777777777");
    const now = new Date("2026-09-23T09:00:00.000Z");
    const boot = await repo.bootstrapOrganization({
      org: { id: orgId, name: "Harbourside Practice", slug: "harbourside", slugLower: "harbourside", createdAt: now },
      member: { id: "11111111-aaaa-4aaa-8aaa-111111111111", orgId, subjectId: "usr_owner", subjectType: "user", createdAt: now },
      roleAssignment: {
        id: "22222222-aaaa-4aaa-8aaa-222222222222",
        orgId,
        subjectId: "usr_owner",
        subjectType: "user",
        role: "owner",
        scopeKind: "organization",
        createdAt: now,
      },
    });
    expect(boot.ok).toBe(true);
    if (boot.ok) {
      expect(boot.value.org.slug).toBe("harbourside");
      expect(boot.value.roleAssignment.role).toBe("owner");
    }

    // Same slug again: a conflict, and nothing half-written left behind.
    const again = await repo.bootstrapOrganization({
      org: { id: asUuid("77777777-7777-4777-8777-777777777778"), name: "Dup", slug: "harbourside", slugLower: "harbourside", createdAt: now },
      member: { id: "11111111-aaaa-4aaa-8aaa-111111111112", orgId: asUuid("77777777-7777-4777-8777-777777777778"), subjectId: "usr_x", subjectType: "user", createdAt: now },
      roleAssignment: {
        id: "22222222-aaaa-4aaa-8aaa-222222222223",
        orgId: asUuid("77777777-7777-4777-8777-777777777778"),
        subjectId: "usr_x",
        subjectType: "user",
        role: "owner",
        scopeKind: "organization",
        createdAt: now,
      },
    });
    expect(again.ok).toBe(false);
    const orgs = db.prepare("SELECT count(*) AS n FROM membership_organizations").get() as { n: number };
    expect(Number(orgs.n)).toBe(1);

    const invited = await repo.createInvitation({
      id: "33333333-aaaa-4aaa-8aaa-333333333333",
      orgId,
      email: "Reviewer@Example.com",
      emailLower: "reviewer@example.com",
      role: "viewer",
      tokenHash: "hash-1",
      invitedBy: "usr_owner",
      expiresAt: new Date("2026-10-23T09:00:00.000Z"),
      createdAt: now,
    });
    expect(invited.ok).toBe(true);

    const accepted = await repo.acceptInvitation({
      tokenHash: "hash-1",
      orgId,
      emailLower: "reviewer@example.com",
      memberId: "44444444-aaaa-4aaa-8aaa-444444444444",
      roleAssignmentId: "55555555-aaaa-4aaa-8aaa-555555555555",
      subjectId: "usr_reviewer",
      subjectType: "user",
      acceptedAt: now,
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.value.invitation.status).toBe("accepted");
      expect(accepted.value.roleAssignment.role).toBe("viewer");
      expect(accepted.value.member.orgId).toBe(orgId);
    }

    // A second accept of the same token finds nothing pending.
    const replay = await repo.acceptInvitation({
      tokenHash: "hash-1",
      orgId,
      emailLower: "reviewer@example.com",
      memberId: "44444444-aaaa-4aaa-8aaa-444444444445",
      roleAssignmentId: "55555555-aaaa-4aaa-8aaa-555555555556",
      subjectId: "usr_reviewer",
      subjectType: "user",
      acceptedAt: now,
    });
    expect(replay.ok).toBe(false);
  });

  it("appends an event WITH its audit entry — the path every audited write takes", async () => {
    // chaseid CH2: this was a Postgres data-modifying CTE with row_to_json,
    // which SQLite cannot parse, so every audited write on D1 failed.
    const repo = createEventsRepository(executor);
    const orgId = "99999999-9999-4999-8999-999999999999";
    const appended = await repo.appendEventWithAudit({
      event: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        type: "chase.director.chased",
        version: 1,
        source: "chase-worker",
        occurredAt: new Date("2026-09-23T09:00:00.000Z"),
        actorType: "system",
        actorId: "chase-worker",
        orgId,
        subjectKind: "director",
        subjectId: "prs_1",
        subjectName: "Jane Director",
        requestId: "req_1",
        payload: { step: 1 },
      },
      audit: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", category: "chase", description: "Sent chase step 1" },
    });
    expect(appended.ok).toBe(true);
    if (appended.ok) {
      expect(appended.value.audit.eventId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      expect(appended.value.audit.category).toBe("chase");
    }

    const page = await repo.queryAuditByOrg(orgId, { limit: 10, cursor: null }, "chase");
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.value.items.map((a) => a.eventType)).toEqual(["chase.director.chased"]);

    // A replay of the same event id is a conflict, not a second row.
    const again = await repo.appendEventWithAudit({
      event: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        type: "chase.director.chased",
        version: 1,
        source: "chase-worker",
        occurredAt: new Date("2026-09-23T09:00:00.000Z"),
        actorType: "system",
        actorId: "chase-worker",
        orgId,
        subjectKind: "director",
        subjectId: "prs_1",
        requestId: "req_1",
        payload: {},
      },
      audit: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    });
    expect(again.ok).toBe(false);
  });

  it("counts a delivery failure streak past the epoch fallback", async () => {
    // The fallback used a `'1970-01-01'::timestamptz` cast; with no prior
    // success the whole count depends on it comparing sanely against the
    // ISO-8601 text the rest of the schema stores.
    const repo = createWebhookRepository(executor);
    const orgId = asUuid("88888888-8888-4888-8888-888888888888");
    const streak = await repo.countConsecutiveEndpointFailures(orgId, "wep_none");
    expect(streak.ok).toBe(true);
    if (streak.ok) expect(streak.value).toBe(0);
  });
});

describe("the expiry sweep's queries, against a real SQLite engine (EX2)", () => {
  let db: DatabaseSync;
  let executor: ReturnType<typeof createSqlExecutor>;
  const orgId = asUuid("12121212-1212-4212-8212-121212121212");
  const itemId = "34343434-3434-4434-8434-343434343434";
  const at = new Date("2026-10-01T10:25:00.000Z");

  beforeEach(async () => {
    db = migratedDatabase();
    executor = createSqlExecutor(d1Over(db));
    const repo = createExpiryRepository(executor);
    const item = await repo.createItem({
      id: itemId,
      orgId,
      projectId: null,
      name: "DEA registration",
      kind: "registration",
      templateKey: "clinic/dea-registration",
      issuer: null,
      identifier: "BX1234563",
      holderName: "Dr. Ng",
      holderEmail: "ng@clinic.test",
      managerEmail: null,
      issuedOn: "2025-10-31",
      expiresOn: "2026-10-31",
      notes: null,
      createdBy: null,
      createdAt: at,
    });
    expect(item.ok).toBe(true);
    const ladder = await repo.createReminders(
      [
        { offsetDays: 90, tier: "holder", scheduledFor: "2026-08-02" },
        { offsetDays: 60, tier: "holder", scheduledFor: "2026-09-01" },
        { offsetDays: 30, tier: "manager", scheduledFor: "2026-10-01" },
        { offsetDays: 7, tier: "owner", scheduledFor: "2026-10-24" },
      ].map((r, i) => ({
        id: `56565656-5656-4656-8656-56565656565${i}`,
        orgId,
        itemId,
        createdAt: at,
        ...r,
      })),
    );
    expect(ladder.ok && ladder.value).toBe(4);
  });

  afterEach(() => {
    db.close();
  });

  it("selects the due rungs with their item, and sends one exactly once", async () => {
    const repo = createExpiryRepository(executor);
    const due = await repo.listDueReminders("2026-10-01", 50);
    expect(due.ok).toBe(true);
    if (!due.ok) return;
    expect(due.value.map((r) => r.offsetDays)).toEqual([90, 60, 30]);
    expect(due.value[2]!.itemExpiresOn).toBe("2026-10-31");
    expect(due.value[2]!.holderEmail).toBe("ng@clinic.test");

    const first = await repo.markReminderSent(due.value[2]!.id, "owner@clinic.test", "ntf_1", at);
    const second = await repo.markReminderSent(due.value[2]!.id, "owner@clinic.test", "ntf_2", at);
    expect(first.ok && first.value).toBe(true);
    expect(second.ok && second.value).toBe(false);
    const row = db
      .prepare("SELECT status, notification_id FROM expiry_reminders WHERE id = ?")
      .get(due.value[2]!.id) as { status: string; notification_id: string };
    expect(row).toEqual({ status: "sent", notification_id: "ntf_1" });

    expect((await repo.markReminderFailed(due.value[0]!.id, at)).ok).toBe(true);
    const after = await repo.listDueReminders("2026-10-01", 50);
    expect(after.ok && after.value.map((r) => r.offsetDays)).toEqual([60]);
  });

  it("reads the org's active owners through membership and identity", async () => {
    const userId = "78787878-7878-4878-8878-787878787878";
    db.prepare(
      "INSERT INTO identity_users (id, email, email_lower) VALUES (?, 'Owner@Clinic.test', 'owner@clinic.test')",
    ).run(userId);
    db.prepare(
      "INSERT INTO membership_organization_members (id, org_id, subject_id) VALUES ('m1', ?, ?)",
    ).run(orgId, userId);
    db.prepare(
      "INSERT INTO membership_role_assignments (id, org_id, subject_id, role) VALUES ('ra1', ?, ?, 'owner')",
    ).run(orgId, userId);
    const repo = createExpiryRepository(executor);
    const owners = await repo.listOwnerEmails(orgId);
    expect(owners).toEqual({ ok: true, value: ["owner@clinic.test"] });
  });

  it("builds the scorecard and ages the overdue", async () => {
    const repo = createExpiryRepository(executor);
    const card = await repo.scorecard(orgId, "2026-10-01", "2026-10-31");
    expect(card.ok && card.value).toEqual([
      { projectId: null, total: 1, active: 1, expiring: 0, expired: 0, renewed: 0, dueWithin30: 1 },
    ]);
    const overdue = await repo.listOverdueItems("2026-11-01", 10);
    expect(overdue.ok && overdue.value.map((i) => i.id)).toEqual([itemId]);
    const aged = await repo.setItemStatus(orgId, itemId, "expired", at);
    expect(aged.ok && aged.value).toBe(true);
  });
});

describe("the expiry edges' queries, against a real SQLite engine (EX3)", () => {
  let db: DatabaseSync;
  let executor: ReturnType<typeof createSqlExecutor>;
  const orgId = asUuid("21212121-2121-4121-8121-212121212121");
  const otherOrg = asUuid("31313131-3131-4131-8131-313131313131");
  const itemId = "41414141-4141-4141-8141-414141414141";
  const at = new Date("2026-10-01T10:00:00.000Z");

  beforeEach(async () => {
    db = migratedDatabase();
    executor = createSqlExecutor(d1Over(db));
    const repo = createExpiryRepository(executor);
    const item = await repo.createItem({
      id: itemId,
      orgId,
      projectId: null,
      name: "OSHA 10 card",
      kind: "certification",
      templateKey: null,
      issuer: null,
      identifier: "SECRET-NUMBER",
      holderName: null,
      holderEmail: null,
      managerEmail: null,
      issuedOn: null,
      expiresOn: "2026-12-01",
      notes: null,
      createdBy: null,
      createdAt: at,
    });
    expect(item.ok).toBe(true);
  });

  afterEach(() => {
    db.close();
  });

  it("scopes a document read by org", async () => {
    const repo = createExpiryRepository(executor);
    const doc = await repo.createDocument({
      id: "51515151-5151-4151-8151-515151515151",
      orgId,
      itemId,
      r2Key: `${orgId}/${itemId}/51515151-5151-4151-8151-515151515151`,
      filename: "card.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      sha256: "ab".repeat(32),
      source: "console",
      uploadedBy: null,
      uploadedAt: at,
    });
    expect(doc.ok).toBe(true);
    expect((await repo.getDocument(orgId, "51515151-5151-4151-8151-515151515151")).ok).toBe(true);
    const cross = await repo.getDocument(otherOrg, "51515151-5151-4151-8151-515151515151");
    expect(cross).toEqual({ ok: false, error: { kind: "not_found" } });
    const listed = await repo.listDocuments(orgId, itemId);
    expect(listed.ok && listed.value.map((d) => d.sizeBytes)).toEqual([1234]);
  });

  it("consumes a renewal link exactly once, and never after it expires", async () => {
    const repo = createExpiryRepository(executor);
    const link = await repo.createRenewalLink({
      id: "61616161-6161-4161-8161-616161616161",
      orgId,
      itemId,
      tokenHash: "hash-live",
      createdBy: null,
      expiresAt: new Date("2026-10-15T10:00:00.000Z"),
      createdAt: at,
    });
    expect(link.ok).toBe(true);
    expect((await repo.findRenewalLinkByHash("hash-live", at)).ok).toBe(true);
    const first = await repo.consumeRenewalLink("61616161-6161-4161-8161-616161616161", at);
    const second = await repo.consumeRenewalLink("61616161-6161-4161-8161-616161616161", at);
    expect(first.ok && first.value).toBe(true);
    expect(second.ok && second.value).toBe(false);
    expect((await repo.findRenewalLinkByHash("hash-live", at)).ok).toBe(false);

    await repo.createRenewalLink({
      id: "71717171-7171-4171-8171-717171717171",
      orgId,
      itemId,
      tokenHash: "hash-old",
      createdBy: null,
      expiresAt: new Date("2026-09-30T10:00:00.000Z"),
      createdAt: at,
    });
    expect((await repo.findRenewalLinkByHash("hash-old", at)).ok).toBe(false);
    const late = await repo.consumeRenewalLink("71717171-7171-4171-8171-717171717171", at);
    expect(late.ok && late.value).toBe(false);
  });

  it("serves a feed until it is revoked, with name, kind and date only", async () => {
    const repo = createExpiryRepository(executor);
    const feed = await repo.createFeedToken({
      id: "81818181-8181-4181-8181-818181818181",
      orgId,
      projectId: null,
      label: "Front desk",
      tokenHash: "feed-hash",
      createdBy: null,
      createdAt: at,
    });
    expect(feed.ok).toBe(true);
    expect((await repo.findFeedTokenByHash("feed-hash")).ok).toBe(true);
    const entries = await repo.listFeedEntries(orgId, null, "2026-09-24", 50);
    expect(entries.ok && entries.value.map((e) => [e.name, e.kind, e.expiresOn])).toEqual([
      ["OSHA 10 card", "certification", "2026-12-01"],
    ]);
    expect(JSON.stringify(entries)).not.toContain("SECRET-NUMBER");
    const scoped = await repo.listFeedEntries(orgId, "91919191-9191-4191-8191-919191919191", "2026-09-24", 50);
    expect(scoped.ok && scoped.value).toEqual([]);
    expect((await repo.touchFeedToken("81818181-8181-4181-8181-818181818181", at)).ok).toBe(true);

    const revoked = await repo.revokeFeedToken(orgId, "81818181-8181-4181-8181-818181818181", at);
    expect(revoked.ok && revoked.value).toBe(true);
    expect((await repo.findFeedTokenByHash("feed-hash")).ok).toBe(false);
    const again = await repo.revokeFeedToken(orgId, "81818181-8181-4181-8181-818181818181", at);
    expect(again.ok && again.value).toBe(false);
  });
});
