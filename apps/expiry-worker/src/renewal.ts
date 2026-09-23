import type { ExpiryItem, ExpiryRepository } from "@saas/db/expiry";
import type { EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import { expiryItemPublicId, orgPublicId } from "./ids.js";
import { ladderRows } from "./ladder.js";

export interface ApplyRenewalInput {
  repo: ExpiryRepository;
  eventsRepo: EventsRepository;
  orgId: Uuid;
  itemId: string;
  expiresOn: string;
  actor: { type: string; id: string };
  via: "console" | "renewal_link";
  requestId: string;
  now: Date;
  today: string;
  newId: () => string;
}

export type ApplyRenewalResult =
  | { ok: true; item: ExpiryItem; skipped: number; scheduled: number }
  | { ok: false; kind: "not_found" | "internal" };

/**
 * The renewal the public link performs — the same three writes the console's
 * `POST …/renew` makes: skip the old ladder's unsent rungs, move the date and
 * status, cut the new ladder; then `expiry.item.renewed` with the link as the
 * actor, so the audit trail says who (or what) renewed it.
 */
export async function applyRenewal(input: ApplyRenewalInput): Promise<ApplyRenewalResult> {
  const before = await input.repo.getItemById(input.orgId, input.itemId);
  if (!before.ok) return { ok: false, kind: "not_found" };

  const skipped = await input.repo.skipPendingReminders(input.orgId, input.itemId, input.now);
  if (!skipped.ok) return { ok: false, kind: "internal" };

  const renewed = await input.repo.updateItem(input.orgId, input.itemId, {
    expiresOn: input.expiresOn,
    status: "active",
    updatedAt: input.now,
  });
  if (!renewed.ok) return { ok: false, kind: "not_found" };

  const rows = ladderRows(input.orgId, input.itemId, input.expiresOn, input.today, input.now, input.newId);
  const scheduled = await input.repo.createReminders(rows);
  if (!scheduled.ok) return { ok: false, kind: "internal" };

  const event = await input.eventsRepo.appendEventWithAudit({
    event: {
      id: input.newId(),
      type: "expiry.item.renewed",
      version: 1,
      source: "expiry-worker",
      occurredAt: input.now,
      actorType: input.actor.type,
      actorId: input.actor.id,
      orgId: input.orgId,
      projectId: renewed.value.projectId,
      subjectKind: "expiry_item",
      subjectId: input.itemId,
      subjectName: renewed.value.name,
      requestId: input.requestId,
      payload: {
        itemId: expiryItemPublicId(input.itemId),
        orgId: orgPublicId(input.orgId),
        previousExpiresOn: before.value.expiresOn,
        expiresOn: input.expiresOn,
        via: input.via,
        remindersSkipped: skipped.value,
        remindersScheduled: rows.length,
      },
    },
    audit: {
      id: input.newId(),
      category: "expiry",
      description: `Renewed "${renewed.value.name}" through a renewal link — ${before.value.expiresOn} → ${input.expiresOn}`,
      projectId: renewed.value.projectId,
    },
  });
  if (!event.ok) return { ok: false, kind: "internal" };
  return { ok: true, item: renewed.value, skipped: skipped.value, scheduled: rows.length };
}
