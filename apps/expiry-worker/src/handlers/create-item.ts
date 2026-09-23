import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ExpiryRepository } from "@saas/db/expiry";
import type { EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import { createExpiryRepository } from "@saas/db/expiry";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { allowed } from "../authz.js";
import { checkBillingEntitlement, decideItemsLimit } from "../billing-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import {
  actorSubjectUuid,
  expiryItemPublicId,
  orgPublicId,
  parseProjectPublicId,
} from "../ids.js";
import { ladderRows, toIsoDate } from "../ladder.js";
import { toPublicItem } from "../present.js";
import { validateItemBody } from "../validate.js";

const ITEMS_LIMIT_ENTITLEMENT_KEY = "limit.expiry_items";

export interface HandleCreateItemDeps {
  expiryRepo?: ExpiryRepository;
  eventsRepo?: EventsRepository;
  checkEntitlement?: typeof checkBillingEntitlement;
  now?: () => Date;
  generateId?: () => string;
}

export async function handleCreateItem(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleCreateItemDeps,
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

  const validation = validateItemBody(body, false);
  if (!validation.valid) {
    return validationError(requestId, validation.fields);
  }
  const fields = validation.value;

  let projectUuid: string | null = null;
  if (fields.projectPublicId) {
    const parsed = parseProjectPublicId(fields.projectPublicId);
    if (!parsed) {
      return validationError(requestId, { projectId: ["Not a project id"] });
    }
    projectUuid = parsed;
  }

  if (!(await allowed(env, actor, orgId, "expiry.item.create", requestId, projectUuid))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const now = deps?.now ? deps.now() : new Date();
  const today = toIsoDate(now);
  const newId = deps?.generateId ?? (() => crypto.randomUUID());

  const executor = deps?.expiryRepo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB);

  try {
    const expiryRepo = deps?.expiryRepo ?? createExpiryRepository(executor!);

    // ── The plan's item ceiling, gated exactly where projects gate theirs:
    // after authorization, before any row is written. Fails closed.
    if (env.BILLING_WORKER) {
      const entitlement = await (deps?.checkEntitlement ?? checkBillingEntitlement)(
        env.BILLING_WORKER,
        orgPublicId(orgId),
        ITEMS_LIMIT_ENTITLEMENT_KEY,
        requestId,
      );
      if (entitlement.kind === "decision") {
        const count = await expiryRepo.countActiveItems(orgId);
        if (!count.ok) {
          return errorResponse("internal_error", "Service unavailable", 503, requestId);
        }
        const gate = decideItemsLimit(entitlement.decision, count.value);
        if (gate.kind === "deny") {
          return errorResponse("precondition_failed", gate.message, 412, requestId, {
            reason: gate.reason,
          });
        }
      }
      // A billing service error is NOT fatal here: the entitlement row is
      // optional in this baseline's seeded plans, and refusing to record a
      // licence because the billing worker blinked is the wrong trade for a
      // product whose whole job is not losing track of one.
    }

    const itemId = newId();
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor!);

    const created = await expiryRepo.createItem({
      id: itemId,
      orgId,
      projectId: projectUuid,
      name: fields.name!,
      kind: fields.kind ?? "license",
      templateKey: fields.templateKey ?? null,
      issuer: fields.issuer ?? null,
      identifier: fields.identifier ?? null,
      holderName: fields.holderName ?? null,
      holderEmail: fields.holderEmail ?? null,
      managerEmail: fields.managerEmail ?? null,
      issuedOn: fields.issuedOn ?? null,
      expiresOn: fields.expiresOn!,
      notes: fields.notes ?? null,
      createdBy: actorSubjectUuid(actor.subjectId),
      createdAt: now,
    });

    if (!created.ok) {
      if (created.error.kind === "conflict") {
        return errorResponse("conflict", "That item already exists", 409, requestId);
      }
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    // The ladder is materialised HERE, in the same call that created the item.
    // `UNIQUE (item_id, offset_days)` makes a second ladder impossible, so a
    // retried request cannot double-chase anyone.
    const rows = ladderRows(orgId, itemId, fields.expiresOn!, today, now, newId);
    const scheduled = await expiryRepo.createReminders(rows);
    if (!scheduled.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const eventResult = await eventsRepo.appendEventWithAudit({
      event: {
        id: newId(),
        type: "expiry.item.created",
        version: 1,
        source: "expiry-worker",
        occurredAt: now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: projectUuid,
        subjectKind: "expiry_item",
        subjectId: itemId,
        subjectName: fields.name!,
        requestId,
        payload: {
          itemId: expiryItemPublicId(itemId),
          orgId: orgPublicId(orgId),
          name: fields.name!,
          kind: fields.kind ?? "license",
          expiresOn: fields.expiresOn!,
          remindersScheduled: rows.length,
        },
      },
      audit: {
        id: newId(),
        category: "expiry",
        description: `Started tracking "${fields.name}", expiring ${fields.expiresOn}`,
        projectId: projectUuid,
      },
    });
    if (!eventResult.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    return successResponse({ item: toPublicItem(created.value, today) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
