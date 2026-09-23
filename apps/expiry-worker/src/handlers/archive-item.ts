import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ExpiryRepository } from "@saas/db/expiry";
import type { EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import { createExpiryRepository } from "@saas/db/expiry";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { allowed } from "../authz.js";
import { errorResponse, successResponse } from "../http.js";
import { expiryItemPublicId, orgPublicId } from "../ids.js";
import { toIsoDate } from "../ladder.js";
import { toPublicItem } from "../present.js";

export interface HandleArchiveItemDeps {
  expiryRepo?: ExpiryRepository;
  eventsRepo?: EventsRepository;
  now?: () => Date;
  generateId?: () => string;
}

export async function handleArchiveItem(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  itemId: string,
  deps?: HandleArchiveItemDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!(await allowed(env, actor, orgId, "expiry.item.delete", requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const now = deps?.now ? deps.now() : new Date();
  const today = toIsoDate(now);
  const newId = deps?.generateId ?? (() => crypto.randomUUID());

  const executor = deps?.expiryRepo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = deps?.expiryRepo ?? createExpiryRepository(executor!);
    const archived = await repo.archiveItem(orgId, itemId, now);
    if (!archived.ok) return errorResponse("not_found", "Not found", 404, requestId);

    // Nobody is chased about something that is no longer tracked.
    const skipped = await repo.skipPendingReminders(orgId, itemId, now);
    if (!skipped.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor!);
    const eventResult = await eventsRepo.appendEventWithAudit({
      event: {
        id: newId(),
        type: "expiry.item.archived",
        version: 1,
        source: "expiry-worker",
        occurredAt: now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: archived.value.projectId,
        subjectKind: "expiry_item",
        subjectId: itemId,
        subjectName: archived.value.name,
        requestId,
        payload: {
          itemId: expiryItemPublicId(itemId),
          orgId: orgPublicId(orgId),
          remindersSkipped: skipped.value,
        },
      },
      audit: {
        id: newId(),
        category: "expiry",
        description: `Stopped tracking "${archived.value.name}"`,
        projectId: archived.value.projectId,
      },
    });
    if (!eventResult.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    return successResponse({ item: toPublicItem(archived.value, today) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
