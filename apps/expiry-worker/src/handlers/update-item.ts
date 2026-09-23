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
import { expiryItemPublicId, orgPublicId, parseProjectPublicId } from "../ids.js";
import { ladderRows, toIsoDate } from "../ladder.js";
import { toPublicItem } from "../present.js";
import { validateItemBody } from "../validate.js";

export interface HandleUpdateItemDeps {
  expiryRepo?: ExpiryRepository;
  eventsRepo?: EventsRepository;
  now?: () => Date;
  generateId?: () => string;
}

export async function handleUpdateItem(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  itemId: string,
  deps?: HandleUpdateItemDeps,
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

  const validation = validateItemBody(body, true);
  if (!validation.valid) {
    return validationError(requestId, validation.fields);
  }
  const fields = validation.value;

  let projectUuid: string | null | undefined;
  if (fields.projectPublicId !== undefined) {
    if (fields.projectPublicId === null) {
      projectUuid = null;
    } else {
      const parsed = parseProjectPublicId(fields.projectPublicId);
      if (!parsed) return validationError(requestId, { projectId: ["Not a project id"] });
      projectUuid = parsed;
    }
  }

  if (!(await allowed(env, actor, orgId, "expiry.item.update", requestId))) {
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

    const patch: UpdateExpiryItemInput = { updatedAt: now };
    if (fields.name !== undefined) patch.name = fields.name;
    if (fields.kind !== undefined) patch.kind = fields.kind;
    if (projectUuid !== undefined) patch.projectId = projectUuid;
    if (fields.issuer !== undefined) patch.issuer = fields.issuer;
    if (fields.identifier !== undefined) patch.identifier = fields.identifier;
    if (fields.holderName !== undefined) patch.holderName = fields.holderName;
    if (fields.holderEmail !== undefined) patch.holderEmail = fields.holderEmail;
    if (fields.managerEmail !== undefined) patch.managerEmail = fields.managerEmail;
    if (fields.issuedOn !== undefined) patch.issuedOn = fields.issuedOn;
    if (fields.notes !== undefined) patch.notes = fields.notes;
    if (fields.expiresOn !== undefined) patch.expiresOn = fields.expiresOn;

    const updated = await repo.updateItem(orgId, itemId, patch);
    if (!updated.ok) return errorResponse("not_found", "Not found", 404, requestId);

    // Moving the date moves the ladder. Rungs already SENT are left alone —
    // a chase that went out is a fact, not a plan — and only the pending ones
    // are re-cut against the new date.
    const dateMoved = fields.expiresOn !== undefined && fields.expiresOn !== before.value.expiresOn;
    if (dateMoved) {
      const cleared = await repo.deletePendingReminders(orgId, itemId);
      if (!cleared.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
      const rescheduled = await repo.createReminders(
        ladderRows(orgId, itemId, fields.expiresOn!, today, now, newId),
      );
      if (!rescheduled.ok) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
    }

    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor!);
    const eventResult = await eventsRepo.appendEventWithAudit({
      event: {
        id: newId(),
        type: "expiry.item.updated",
        version: 1,
        source: "expiry-worker",
        occurredAt: now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: updated.value.projectId,
        subjectKind: "expiry_item",
        subjectId: itemId,
        subjectName: updated.value.name,
        requestId,
        payload: {
          itemId: expiryItemPublicId(itemId),
          orgId: orgPublicId(orgId),
          expiresOn: updated.value.expiresOn,
          ladderRecut: dateMoved,
        },
      },
      audit: {
        id: newId(),
        category: "expiry",
        description: dateMoved
          ? `Updated "${updated.value.name}" — now expiring ${updated.value.expiresOn}`
          : `Updated "${updated.value.name}"`,
        projectId: updated.value.projectId,
      },
    });
    if (!eventResult.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    return successResponse({ item: toPublicItem(updated.value, today) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
