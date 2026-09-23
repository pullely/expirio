import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ExpiryRepository, UpdateExpiryItemInput } from "@saas/db/expiry";
import type { EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import { createExpiryRepository } from "@saas/db/expiry";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { allowed } from "../authz.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { expiryItemPublicId, orgPublicId } from "../ids.js";
import { isIsoDate, ladderRows, toIsoDate } from "../ladder.js";
import { toPublicItem } from "../present.js";

export interface HandleRenewItemDeps {
  expiryRepo?: ExpiryRepository;
  eventsRepo?: EventsRepository;
  now?: () => Date;
  generateId?: () => string;
}

/**
 * The renewal. This is the event the product exists to produce: an item whose
 * new date is in the future, a fresh ladder cut against it, and the old
 * ladder's unsent rungs marked `skipped` so nothing chases a licence that has
 * already been renewed.
 */
export async function handleRenewItem(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  itemId: string,
  deps?: HandleRenewItemDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }

  const req = (body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string[]> = {};
  if (typeof req.expiresOn !== "string" || !isIsoDate(req.expiresOn)) {
    fields.expiresOn = ["Must be a calendar date, YYYY-MM-DD"];
  }
  if (req.identifier !== undefined && req.identifier !== null && typeof req.identifier !== "string") {
    fields.identifier = ["Must be a string or null"];
  }
  if (req.notes !== undefined && req.notes !== null && typeof req.notes !== "string") {
    fields.notes = ["Must be a string or null"];
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  const expiresOn = req.expiresOn as string;

  if (!(await allowed(env, actor, orgId, "expiry.item.renew", requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const now = deps?.now ? deps.now() : new Date();
  const today = toIsoDate(now);
  const newId = deps?.generateId ?? (() => crypto.randomUUID());

  const executor = deps?.expiryRepo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = deps?.expiryRepo ?? createExpiryRepository(executor!);

    const before = await repo.getItemById(orgId, itemId);
    if (!before.ok) return errorResponse("not_found", "Not found", 404, requestId);

    // Order matters: skip the old ladder BEFORE the new one is written, so a
    // rung that both ladders would occupy (`UNIQUE (item_id, offset_days)`)
    // is the new one, not a stale `pending` row the sweep would have sent.
    const skipped = await repo.skipPendingReminders(orgId, itemId, now);
    if (!skipped.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    // `exactOptionalPropertyTypes` is on, so an absent field must be absent
    // from the object, not present-and-undefined — the two mean different
    // things to the patch builder (leave alone vs. set to null).
    const patch: UpdateExpiryItemInput = {
      expiresOn,
      status: "active",
      updatedAt: now,
    };
    if (req.identifier !== undefined) patch.identifier = req.identifier as string | null;
    if (req.notes !== undefined) patch.notes = req.notes as string | null;

    const renewed = await repo.updateItem(orgId, itemId, patch);
    if (!renewed.ok) return errorResponse("not_found", "Not found", 404, requestId);

    const rows = ladderRows(orgId, itemId, expiresOn, today, now, newId);
    const scheduled = await repo.createReminders(rows);
    if (!scheduled.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor!);
    const eventResult = await eventsRepo.appendEventWithAudit({
      event: {
        id: newId(),
        type: "expiry.item.renewed",
        version: 1,
        source: "expiry-worker",
        occurredAt: now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: renewed.value.projectId,
        subjectKind: "expiry_item",
        subjectId: itemId,
        subjectName: renewed.value.name,
        requestId,
        payload: {
          itemId: expiryItemPublicId(itemId),
          orgId: orgPublicId(orgId),
          previousExpiresOn: before.value.expiresOn,
          expiresOn,
          remindersSkipped: skipped.value,
          remindersScheduled: rows.length,
        },
      },
      audit: {
        id: newId(),
        category: "expiry",
        description: `Renewed "${renewed.value.name}" — ${before.value.expiresOn} → ${expiresOn}`,
        projectId: renewed.value.projectId,
      },
    });
    if (!eventResult.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    return successResponse({ item: toPublicItem(renewed.value, today) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
