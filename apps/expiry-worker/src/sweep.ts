import type { Env } from "./env.js";
import type { DueReminder, ExpiryRepository } from "@saas/db/expiry";
import type { EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import { createExpiryRepository } from "@saas/db/expiry";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import {
  buildIdempotencyKey,
  enqueueNotification,
  type EnqueueNotificationResult,
} from "@saas/notifications-client";
import { daysBetween, shiftDate, toIsoDate } from "./ladder.js";
import { expiryItemPublicId, expiryReminderPublicId, orgPublicId } from "./ids.js";

/** Rungs handled per tick. The sweep runs hourly, so a backlog drains in hours, not in one invocation. */
export const SWEEP_REMINDER_LIMIT = 200;
/** Items aged to `expired` per tick. */
export const SWEEP_OVERDUE_LIMIT = 200;
/** A rung at or inside this many days moves an `active` item to `expiring`. */
export const EXPIRING_WINDOW_DAYS = 30;

const ACTOR = { actorType: "system", actorId: "expiry-worker" } as const;

export type SweepOutcome = "sent" | "skipped" | "failed" | "deferred" | "lost_race";

export interface SweepReport {
  today: string;
  due: number;
  sent: number;
  skipped: number;
  failed: number;
  deferred: number;
  expired: number;
}

export interface SweepDeps {
  expiryRepo: ExpiryRepository;
  eventsRepo: EventsRepository;
  enqueue: (
    request: Parameters<typeof enqueueNotification>[2],
    requestId: string,
  ) => Promise<EnqueueNotificationResult>;
  now: () => Date;
  generateId: () => string;
}

/**
 * Why a due rung is NOT sent. `null` means send it.
 *
 * - the item was archived or renewed after the rung was written;
 * - the item's date moved and this rung was cut against the old one (a PATCH
 *   re-cuts the ladder, but a row from before that is never trusted blindly).
 */
export function staleReason(r: DueReminder): string | null {
  if (r.itemStatus === "archived") return "item_archived";
  if (r.itemStatus === "renewed") return "item_renewed";
  if (shiftDate(r.itemExpiresOn, -r.offsetDays) !== r.scheduledFor) return "date_moved";
  return null;
}

/**
 * Who a rung chases. Escalation falls UPWARD when a tier has nobody on file:
 * a holder rung with no holder email goes to the manager, then the owner; a
 * manager rung with no manager goes to the owner. It never falls downward — an
 * owner rung is never quietly handed to the holder.
 */
export function resolveRecipient(r: DueReminder, ownerEmails: readonly string[]): string | null {
  const owner = ownerEmails[0] ?? null;
  if (r.tier === "holder") return r.holderEmail ?? r.managerEmail ?? owner;
  if (r.tier === "manager") return r.managerEmail ?? owner;
  return owner;
}

export function templateKeyFor(tier: string): string {
  if (tier === "holder") return "expiry.reminder.holder";
  if (tier === "manager") return "expiry.reminder.manager";
  return "expiry.reminder.owner";
}

/**
 * One tick of the clock. Two passes:
 *
 * 1. every `pending` rung due on or before today, oldest first, is sent once —
 *    `markReminderSent`'s `status = 'pending'` predicate is the exactly-once,
 *    and the notification's idempotency key collapses a racing second sweep's
 *    enqueue onto the first;
 * 2. every `active`/`expiring` item whose date has passed is aged to `expired`.
 *
 * Each rung is its own unit: one failure is counted and the sweep moves on.
 */
export async function runSweep(deps: SweepDeps): Promise<SweepReport> {
  const now = deps.now();
  const today = toIsoDate(now);
  const report: SweepReport = { today, due: 0, sent: 0, skipped: 0, failed: 0, deferred: 0, expired: 0 };

  const due = await deps.expiryRepo.listDueReminders(today, SWEEP_REMINDER_LIMIT);
  if (due.ok) {
    report.due = due.value.length;
    const owners = new Map<string, string[]>();
    for (const rung of due.value) {
      let outcome: SweepOutcome;
      try {
        outcome = await sweepOne(rung, today, now, owners, deps);
      } catch {
        outcome = "deferred";
      }
      if (outcome === "sent") report.sent += 1;
      else if (outcome === "skipped") report.skipped += 1;
      else if (outcome === "failed") report.failed += 1;
      else if (outcome === "deferred") report.deferred += 1;
    }
  }

  const overdue = await deps.expiryRepo.listOverdueItems(today, SWEEP_OVERDUE_LIMIT);
  if (overdue.ok) {
    for (const item of overdue.value) {
      try {
        const changed = await deps.expiryRepo.setItemStatus(item.orgId, item.id, "expired", now);
        if (!changed.ok || !changed.value) continue;
        report.expired += 1;
        await deps.eventsRepo.appendEventWithAudit({
          event: {
            id: deps.generateId(),
            type: "expiry.item.expired",
            version: 1,
            source: "expiry-worker",
            occurredAt: now,
            ...ACTOR,
            orgId: item.orgId,
            projectId: item.projectId,
            subjectKind: "expiry_item",
            subjectId: item.id,
            subjectName: item.name,
            requestId: `sweep_${today}`,
            idempotencyKey: `expiry.item.expired:${item.id}:${item.expiresOn}`,
            payload: {
              itemId: expiryItemPublicId(item.id),
              orgId: orgPublicId(item.orgId),
              name: item.name,
              expiresOn: item.expiresOn,
            },
          },
          audit: {
            id: deps.generateId(),
            category: "expiry",
            description: `"${item.name}" lapsed on ${item.expiresOn}`,
            projectId: item.projectId,
          },
        });
      } catch {
        // One item's failure never stops the pass; it is retried next tick
        // only if the status flip did not land, which is the safe direction.
      }
    }
  }

  return report;
}

async function sweepOne(
  rung: DueReminder,
  today: string,
  now: Date,
  ownerCache: Map<string, string[]>,
  deps: SweepDeps,
): Promise<SweepOutcome> {
  if (staleReason(rung)) {
    const skipped = await deps.expiryRepo.markReminderSkipped(rung.id, now);
    return skipped.ok && skipped.value ? "skipped" : "lost_race";
  }

  let owners = ownerCache.get(rung.orgId);
  if (!owners) {
    const read = await deps.expiryRepo.listOwnerEmails(rung.orgId as Uuid);
    if (!read.ok) return "deferred";
    owners = read.value;
    ownerCache.set(rung.orgId, owners);
  }

  const recipient = resolveRecipient(rung, owners);
  if (!recipient) {
    const failed = await deps.expiryRepo.markReminderFailed(rung.id, now);
    return failed.ok && failed.value ? "failed" : "lost_race";
  }

  const reminderPublicId = expiryReminderPublicId(rung.id);
  const daysRemaining = daysBetween(today, rung.itemExpiresOn);
  // No licence number, no identifier, nothing a forwarded email should not carry.
  const sent = await deps.enqueue(
    {
      orgId: rung.orgId,
      category: "product",
      templateKey: templateKeyFor(rung.tier),
      templateData: {
        itemName: rung.itemName,
        itemKind: rung.itemKind,
        expiresOn: rung.itemExpiresOn,
        daysRemaining,
        offsetDays: rung.offsetDays,
        tier: rung.tier,
      },
      recipient: { channel: "email", address: recipient },
      idempotencyKey: buildIdempotencyKey("expiry.reminder", reminderPublicId),
      correlationId: reminderPublicId,
    },
    `sweep_${today}`,
  );
  // Leave the rung `pending` when the enqueue did not land — the next tick
  // retries it, and the idempotency key makes that retry safe.
  if (!sent.ok) return "deferred";

  const marked = await deps.expiryRepo.markReminderSent(rung.id, recipient, sent.notificationId, now);
  if (!marked.ok) return "deferred";
  if (!marked.value) return "lost_race";

  if (rung.offsetDays <= EXPIRING_WINDOW_DAYS && rung.itemStatus === "active" && daysRemaining >= 0) {
    await deps.expiryRepo.setItemStatus(rung.orgId, rung.itemId, "expiring", now);
  }

  await deps.eventsRepo.appendEventWithAudit({
    event: {
      id: deps.generateId(),
      type: "expiry.reminder.sent",
      version: 1,
      source: "expiry-worker",
      occurredAt: now,
      ...ACTOR,
      orgId: rung.orgId,
      projectId: rung.itemProjectId,
      subjectKind: "expiry_item",
      subjectId: rung.itemId,
      subjectName: rung.itemName,
      requestId: `sweep_${today}`,
      idempotencyKey: `expiry.reminder.sent:${rung.id}`,
      payload: {
        reminderId: reminderPublicId,
        itemId: expiryItemPublicId(rung.itemId),
        orgId: orgPublicId(rung.orgId),
        tier: rung.tier,
        offsetDays: rung.offsetDays,
        expiresOn: rung.itemExpiresOn,
        notificationId: sent.notificationId,
      },
    },
    audit: {
      id: deps.generateId(),
      category: "expiry",
      description: `Reminded the ${rung.tier} that "${rung.itemName}" expires ${rung.itemExpiresOn} (${rung.offsetDays}-day rung)`,
      projectId: rung.itemProjectId,
    },
  });
  return "sent";
}

/** The `scheduled()` entry point: real repositories over D1, the real notifications binding. */
export async function runScheduledSweep(env: Env): Promise<SweepReport | null> {
  if (!env.PLATFORM_DB) return null;
  const executor = createSqlExecutor(env.PLATFORM_DB);
  try {
    const report = await runSweep({
      expiryRepo: createExpiryRepository(executor),
      eventsRepo: createEventsRepository(executor),
      enqueue: (request, requestId) =>
        enqueueNotification(
          env,
          {
            internalActor: "expiry-worker",
            actorSubjectType: "system",
            actorSubjectId: "expiry-worker",
            requestId,
          },
          request,
        ),
      now: () => new Date(),
      generateId: () => crypto.randomUUID(),
    });
    // eslint-disable-next-line no-console -- one structured line per tick for Workers Logs
    console.log(JSON.stringify({ level: "info", msg: "expiry.sweep", ...report }));
    return report;
  } finally {
    await executor.dispose();
  }
}
