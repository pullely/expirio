import type { DueReminder, ExpiryItem, ExpiryRepository } from "@saas/db/expiry";
import type { EventsRepository } from "@saas/db/events";
import {
  resolveRecipient,
  runSweep,
  staleReason,
  templateKeyFor,
  type SweepDeps,
} from "@expiry-worker/sweep";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-01T10:25:00.000Z");

function rung(over: Partial<DueReminder> = {}): DueReminder {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    orgId: ORG,
    itemId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    offsetDays: 30,
    tier: "manager",
    scheduledFor: "2026-10-01",
    status: "pending",
    recipient: null,
    notificationId: null,
    sentAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    itemName: "DEA registration",
    itemKind: "registration",
    itemStatus: "active",
    itemExpiresOn: "2026-10-31",
    itemProjectId: null,
    holderEmail: "holder@clinic.test",
    managerEmail: "manager@clinic.test",
    ...over,
  };
}

/**
 * A fake repository with a real `status = 'pending'` predicate, so the
 * exactly-once property is exercised rather than assumed.
 */
function harness(due: DueReminder[], opts: { owners?: string[]; overdue?: ExpiryItem[]; enqueueOk?: boolean } = {}) {
  const status = new Map(due.map((r) => [r.id, "pending"]));
  const sent: Array<{ id: string; recipient: string; notificationId: string | null }> = [];
  const itemStatus: Array<{ itemId: string; status: string }> = [];
  const events: string[] = [];
  const enqueued: Array<{ templateKey: string; address: string; key?: string; data: unknown }> = [];

  const flip = (id: string, to: string) => {
    if (status.get(id) !== "pending") return false;
    status.set(id, to);
    return true;
  };

  const expiryRepo = {
    listDueReminders: async () => ({ ok: true, value: due.filter((r) => status.get(r.id) === "pending") }),
    listOwnerEmails: async () => ({ ok: true, value: opts.owners ?? ["owner@clinic.test"] }),
    markReminderSkipped: async (id: string) => ({ ok: true, value: flip(id, "skipped") }),
    markReminderFailed: async (id: string) => ({ ok: true, value: flip(id, "failed") }),
    markReminderSent: async (id: string, recipient: string, notificationId: string | null) => {
      const ok = flip(id, "sent");
      if (ok) sent.push({ id, recipient, notificationId });
      return { ok: true, value: ok };
    },
    setItemStatus: async (_org: string, itemId: string, s: string) => {
      itemStatus.push({ itemId, status: s });
      return { ok: true, value: true };
    },
    listOverdueItems: async () => ({ ok: true, value: opts.overdue ?? [] }),
  } as unknown as ExpiryRepository;

  const eventsRepo = {
    appendEventWithAudit: async (input: { event: { type: string } }) => {
      events.push(input.event.type);
      return { ok: true, value: {} };
    },
  } as unknown as EventsRepository;

  let n = 0;
  const deps: SweepDeps = {
    expiryRepo,
    eventsRepo,
    enqueue: async (req) => {
      enqueued.push({
        templateKey: req.templateKey,
        address: req.recipient.address,
        ...(req.idempotencyKey ? { key: req.idempotencyKey } : {}),
        data: req.templateData,
      });
      return opts.enqueueOk === false
        ? { ok: false, reason: "non_2xx" }
        : { ok: true, notificationId: `ntf_${enqueued.length}` };
    },
    now: () => NOW,
    generateId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  };
  return { deps, status, sent, itemStatus, events, enqueued };
}

describe("resolveRecipient — escalation falls upward, never down", () => {
  it("sends each tier to its own address", () => {
    expect(resolveRecipient(rung({ tier: "holder" }), ["o@x.test"])).toBe("holder@clinic.test");
    expect(resolveRecipient(rung({ tier: "manager" }), ["o@x.test"])).toBe("manager@clinic.test");
    expect(resolveRecipient(rung({ tier: "owner" }), ["o@x.test"])).toBe("o@x.test");
  });

  it("falls from holder to manager to owner when a tier has nobody on file", () => {
    expect(resolveRecipient(rung({ tier: "holder", holderEmail: null }), ["o@x.test"])).toBe("manager@clinic.test");
    expect(resolveRecipient(rung({ tier: "holder", holderEmail: null, managerEmail: null }), ["o@x.test"])).toBe("o@x.test");
    expect(resolveRecipient(rung({ tier: "manager", managerEmail: null }), ["o@x.test"])).toBe("o@x.test");
  });

  it("never hands an owner rung to the holder", () => {
    expect(resolveRecipient(rung({ tier: "owner" }), [])).toBeNull();
  });
});

describe("staleReason", () => {
  it("sends a rung that still matches its item", () => {
    expect(staleReason(rung())).toBeNull();
  });
  it("skips archived and renewed items, and rungs cut against an old date", () => {
    expect(staleReason(rung({ itemStatus: "archived" }))).toBe("item_archived");
    expect(staleReason(rung({ itemStatus: "renewed" }))).toBe("item_renewed");
    expect(staleReason(rung({ itemExpiresOn: "2027-10-31" }))).toBe("date_moved");
  });
});

describe("runSweep", () => {
  it("sends a due rung exactly once across two consecutive ticks, and records its notification id", async () => {
    const h = harness([rung()]);
    const first = await runSweep(h.deps);
    const second = await runSweep(h.deps);
    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.due).toBe(0);
    expect(h.enqueued).toHaveLength(1);
    expect(h.sent).toEqual([
      { id: rung().id, recipient: "manager@clinic.test", notificationId: "ntf_1" },
    ]);
    expect(h.events).toEqual(["expiry.reminder.sent"]);
  });

  it("uses the tier's template and a reminder-scoped idempotency key, and never mails the licence number", async () => {
    const h = harness([rung({ tier: "holder", offsetDays: 90, itemExpiresOn: "2026-12-30" })]);
    await runSweep(h.deps);
    expect(h.enqueued[0]!.templateKey).toBe(templateKeyFor("holder"));
    expect(h.enqueued[0]!.key).toMatch(/^expiry\.reminder:exr_[0-9a-f]{32}$/);
    expect(JSON.stringify(h.enqueued[0]!.data)).not.toMatch(/identifier/);
  });

  it("marks a renewed item's stale rung skipped instead of sending it", async () => {
    const h = harness([rung({ itemStatus: "renewed" })]);
    const report = await runSweep(h.deps);
    expect(report.skipped).toBe(1);
    expect(h.enqueued).toHaveLength(0);
    expect(h.status.get(rung().id)).toBe("skipped");
  });

  it("leaves a rung pending when the enqueue fails, so the next tick retries it", async () => {
    const h = harness([rung()], { enqueueOk: false });
    const report = await runSweep(h.deps);
    expect(report.deferred).toBe(1);
    expect(h.status.get(rung().id)).toBe("pending");
  });

  it("fails a rung that has nobody to send to", async () => {
    const h = harness([rung({ tier: "owner" })], { owners: [] });
    const report = await runSweep(h.deps);
    expect(report.failed).toBe(1);
    expect(h.status.get(rung().id)).toBe("failed");
  });

  it("moves an active item to expiring on a rung inside 30 days", async () => {
    const h = harness([rung({ offsetDays: 30 })]);
    await runSweep(h.deps);
    expect(h.itemStatus).toEqual([{ itemId: rung().itemId, status: "expiring" }]);
  });

  it("ages overdue items to expired and appends expiry.item.expired", async () => {
    const overdue = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      orgId: ORG,
      projectId: null,
      name: "OSHA 10 card",
      expiresOn: "2026-09-30",
      status: "expiring",
    } as ExpiryItem;
    const h = harness([], { overdue: [overdue] });
    const report = await runSweep(h.deps);
    expect(report.expired).toBe(1);
    expect(h.itemStatus).toEqual([{ itemId: overdue.id, status: "expired" }]);
    expect(h.events).toEqual(["expiry.item.expired"]);
  });
});
