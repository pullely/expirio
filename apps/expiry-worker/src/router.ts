import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleCreateItem } from "./handlers/create-item.js";
import { handleListItems } from "./handlers/list-items.js";
import { handleGetItem } from "./handlers/get-item.js";
import { handleUpdateItem } from "./handlers/update-item.js";
import { handleArchiveItem } from "./handlers/archive-item.js";
import { handleRenewItem } from "./handlers/renew-item.js";
import { handleListReminders } from "./handlers/list-reminders.js";
import { handleListTemplates } from "./handlers/list-templates.js";
import { handleApplyTemplate } from "./handlers/apply-template.js";
import { handleScorecard } from "./handlers/scorecard.js";
import { errorResponse, methodNotAllowed, notFound } from "./http.js";
import { generateRequestId, parseExpiryItemPublicId, parseOrgPublicId } from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

/**
 * This worker is unreachable except over a service binding from api-edge, so
 * the actor arrives as headers the edge resolved and set — never as a token.
 */
function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

const ORG_ITEMS_RE = /^\/v1\/organizations\/([^/]+)\/expiry-items$/;
const ORG_ITEM_ID_RE = /^\/v1\/organizations\/([^/]+)\/expiry-items\/([^/]+)$/;
const ORG_ITEM_RENEW_RE = /^\/v1\/organizations\/([^/]+)\/expiry-items\/([^/]+)\/renew$/;
const ORG_ITEM_REMINDERS_RE = /^\/v1\/organizations\/([^/]+)\/expiry-items\/([^/]+)\/reminders$/;
const ORG_TEMPLATES_RE = /^\/v1\/organizations\/([^/]+)\/expiry-templates$/;
const ORG_TEMPLATE_APPLY_RE = /^\/v1\/organizations\/([^/]+)\/expiry-templates\/([a-z0-9-]{1,32})\/apply$/;
const ORG_SCORECARD_RE = /^\/v1\/organizations\/([^/]+)\/expiry-scorecard$/;

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    const templatesMatch = url.pathname.match(ORG_TEMPLATES_RE);
    if (templatesMatch) {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      const orgUuid = parseOrgPublicId(templatesMatch[1]!);
      if (!orgUuid) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      return handleListTemplates(env, requestId, actor, orgUuid);
    }

    const applyMatch = url.pathname.match(ORG_TEMPLATE_APPLY_RE);
    if (applyMatch) {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      const orgUuid = parseOrgPublicId(applyMatch[1]!);
      if (!orgUuid) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      return handleApplyTemplate(request, env, requestId, actor, orgUuid, applyMatch[2]!);
    }

    const scorecardMatch = url.pathname.match(ORG_SCORECARD_RE);
    if (scorecardMatch) {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      const orgUuid = parseOrgPublicId(scorecardMatch[1]!);
      if (!orgUuid) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      return handleScorecard(env, requestId, actor, orgUuid);
    }

    const renewMatch = url.pathname.match(ORG_ITEM_RENEW_RE);
    if (renewMatch) {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      const orgUuid = parseOrgPublicId(renewMatch[1]!);
      const itemUuid = parseExpiryItemPublicId(renewMatch[2]!);
      if (!orgUuid || !itemUuid) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      return handleRenewItem(request, env, requestId, actor, orgUuid, itemUuid);
    }

    const remindersMatch = url.pathname.match(ORG_ITEM_REMINDERS_RE);
    if (remindersMatch) {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      const orgUuid = parseOrgPublicId(remindersMatch[1]!);
      const itemUuid = parseExpiryItemPublicId(remindersMatch[2]!);
      if (!orgUuid || !itemUuid) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      return handleListReminders(env, requestId, actor, orgUuid, itemUuid);
    }

    const itemMatch = url.pathname.match(ORG_ITEM_ID_RE);
    if (itemMatch) {
      const orgUuid = parseOrgPublicId(itemMatch[1]!);
      const itemUuid = parseExpiryItemPublicId(itemMatch[2]!);
      if (!orgUuid || !itemUuid) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);

      if (request.method === "GET") {
        return handleGetItem(env, requestId, actor, orgUuid, itemUuid);
      }
      if (request.method === "PATCH") {
        return handleUpdateItem(request, env, requestId, actor, orgUuid, itemUuid);
      }
      if (request.method === "DELETE") {
        return handleArchiveItem(env, requestId, actor, orgUuid, itemUuid);
      }
      return methodNotAllowed(requestId);
    }

    const itemsMatch = url.pathname.match(ORG_ITEMS_RE);
    if (itemsMatch) {
      const orgUuid = parseOrgPublicId(itemsMatch[1]!);
      if (!orgUuid) return errorResponse("not_found", "Not found", 404, requestId);
      const actor = resolveActor(request);
      if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, requestId);

      if (request.method === "POST") {
        return handleCreateItem(request, env, requestId, actor, orgUuid);
      }
      if (request.method === "GET") {
        return handleListItems(request, env, requestId, actor, orgUuid);
      }
      return methodNotAllowed(requestId);
    }

    return notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
