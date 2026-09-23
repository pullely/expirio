import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ExpiryItem, ExpiryRepository } from "@saas/db/expiry";
import type { EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import { createExpiryRepository } from "@saas/db/expiry";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { allowed } from "../authz.js";
import { checkBillingEntitlement, decideItemsLimit } from "../billing-client.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { actorSubjectUuid, expiryItemPublicId, orgPublicId, parseProjectPublicId } from "../ids.js";
import { ladderRows, toIsoDate } from "../ladder.js";
import { toPublicItem } from "../present.js";
import { addMonths, findTemplate, selectTemplateItems } from "../template-catalog.js";
import { validateApplyTemplateBody } from "../validate.js";

const ITEMS_LIMIT_ENTITLEMENT_KEY = "limit.expiry_items";

export interface HandleApplyTemplateDeps {
  expiryRepo?: ExpiryRepository;
  eventsRepo?: EventsRepository;
  checkEntitlement?: typeof checkBillingEntitlement;
  now?: () => Date;
  generateId?: () => string;
}

/**
 * Fan one vertical out into its set of tracked items, in one call. Each item
 * gets its own ladder and its own `expiry.item.created` event, so a webhook
 * subscriber sees exactly what a hand-entered item would have produced.
 *
 * Authorized as `expiry.item.create` — applying a template IS creating items,
 * and a role that may create one item may create five. (The design named a
 * separate `expiry.template.apply` action; folding it in keeps the policy
 * package, and so policy-worker, untouched. Recorded in IMPLEMENTATION-STATUS.)
 */
export async function handleApplyTemplate(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  templateKey: string,
  deps?: HandleApplyTemplateDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const template = findTemplate(templateKey);
  if (!template) return errorResponse("not_found", "Not found", 404, requestId);

  let body: unknown = {};
  const raw = await request.text();
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return validationError(requestId, { body: ["Invalid JSON"] });
    }
  }
  const validation = validateApplyTemplateBody(body);
  if (!validation.valid) return validationError(requestId, validation.fields);
  const fields = validation.value;

  const selection = selectTemplateItems(template, fields.itemKeys);
  if (selection.unknown.length > 0) {
    return validationError(requestId, {
      itemKeys: [`Not in the ${template.key} template: ${selection.unknown.join(", ")}`],
    });
  }
  if (selection.items.length === 0) {
    return validationError(requestId, { itemKeys: ["Select at least one item"] });
  }

  let projectUuid: string | null = null;
  if (fields.projectPublicId) {
    const parsed = parseProjectPublicId(fields.projectPublicId);
    if (!parsed) return validationError(requestId, { projectId: ["Not a project id"] });
    projectUuid = parsed;
  }

  if (!(await allowed(env, actor, orgId, "expiry.item.create", requestId, projectUuid))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const now = deps?.now ? deps.now() : new Date();
  const today = toIsoDate(now);
  const issuedOn = fields.issuedOn ?? today;
  const newId = deps?.generateId ?? (() => crypto.randomUUID());

  const executor = deps?.expiryRepo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const expiryRepo = deps?.expiryRepo ?? createExpiryRepository(executor!);
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor!);

    // The plan ceiling is checked against the whole batch, not item by item:
    // a template that would cross the limit halfway is refused before any row.
    if (env.BILLING_WORKER) {
      const entitlement = await (deps?.checkEntitlement ?? checkBillingEntitlement)(
        env.BILLING_WORKER,
        orgPublicId(orgId),
        ITEMS_LIMIT_ENTITLEMENT_KEY,
        requestId,
      );
      if (entitlement.kind === "decision") {
        const count = await expiryRepo.countActiveItems(orgId);
        if (!count.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
        const gate = decideItemsLimit(entitlement.decision, count.value + selection.items.length - 1);
        if (gate.kind === "deny") {
          return errorResponse("precondition_failed", gate.message, 412, requestId, {
            reason: gate.reason,
          });
        }
      }
    }

    const created: ExpiryItem[] = [];
    for (const row of selection.items) {
      const itemId = newId();
      const expiresOn = addMonths(issuedOn, row.validityMonths);
      const name = fields.holderName ? `${row.name} — ${fields.holderName}` : row.name;
      const item = await expiryRepo.createItem({
        id: itemId,
        orgId,
        projectId: projectUuid,
        name,
        kind: row.kind,
        templateKey: `${template.key}/${row.key}`,
        issuer: row.issuer,
        identifier: null,
        holderName: fields.holderName,
        holderEmail: fields.holderEmail,
        managerEmail: fields.managerEmail,
        issuedOn,
        expiresOn,
        notes: null,
        createdBy: actorSubjectUuid(actor.subjectId),
        createdAt: now,
      });
      if (!item.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

      const rows = ladderRows(orgId, itemId, expiresOn, today, now, newId);
      const scheduled = await expiryRepo.createReminders(rows);
      if (!scheduled.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);

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
          subjectName: name,
          requestId,
          payload: {
            itemId: expiryItemPublicId(itemId),
            orgId: orgPublicId(orgId),
            name,
            kind: row.kind,
            expiresOn,
            templateKey: `${template.key}/${row.key}`,
            remindersScheduled: rows.length,
          },
        },
        audit: {
          id: newId(),
          category: "expiry",
          description: `Started tracking "${name}" from the ${template.name} template, expiring ${expiresOn}`,
          projectId: projectUuid,
        },
      });
      if (!eventResult.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
      created.push(item.value);
    }

    return successResponse(
      { template: template.key, items: created.map((i) => toPublicItem(i, today)) },
      requestId,
      201,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
