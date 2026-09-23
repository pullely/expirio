import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ExpiryRepository, ListExpiryItemsFilter } from "@saas/db/expiry";
import type { Uuid } from "@saas/db/ids";
import { createExpiryRepository } from "@saas/db/expiry";
import { createSqlExecutor } from "@saas/db/d1";
import { allowed } from "../authz.js";
import { errorResponse, validationError } from "../http.js";
import { parseProjectPublicId } from "../ids.js";
import { isIsoDate, toIsoDate } from "../ladder.js";
import { encodeCursor, parsePageParams } from "../pagination.js";
import { toPublicItem } from "../present.js";
import {
  EXPIRY_ITEM_KINDS,
  EXPIRY_ITEM_STATUSES,
  type ExpiryItemKind,
  type ExpiryItemStatus,
} from "@saas/contracts/expiry";

export interface HandleListItemsDeps {
  expiryRepo?: ExpiryRepository;
  now?: () => Date;
}

export async function handleListItems(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleListItemsDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const url = new URL(request.url);
  const page = parsePageParams(url);
  if (!page.ok) {
    return validationError(requestId, { [page.field]: [page.reason] });
  }

  const filter: ListExpiryItemsFilter = {};
  const fields: Record<string, string[]> = {};

  const projectParam = url.searchParams.get("projectId");
  if (projectParam !== null) {
    if (projectParam === "none") {
      filter.projectId = null;
    } else {
      const parsed = parseProjectPublicId(projectParam);
      if (!parsed) {
        fields.projectId = ["Not a project id"];
      } else {
        filter.projectId = parsed;
      }
    }
  }

  const kindParam = url.searchParams.get("kind");
  if (kindParam !== null) {
    if (!EXPIRY_ITEM_KINDS.includes(kindParam as ExpiryItemKind)) {
      fields.kind = [`Must be one of: ${EXPIRY_ITEM_KINDS.join(", ")}`];
    } else {
      filter.kind = kindParam;
    }
  }

  const statusParam = url.searchParams.get("status");
  if (statusParam !== null) {
    if (!EXPIRY_ITEM_STATUSES.includes(statusParam as ExpiryItemStatus)) {
      fields.status = [`Must be one of: ${EXPIRY_ITEM_STATUSES.join(", ")}`];
    } else {
      filter.status = statusParam;
    }
  }

  for (const [param, key] of [
    ["expiresBefore", "expiresBefore"],
    ["expiresAfter", "expiresAfter"],
  ] as const) {
    const raw = url.searchParams.get(param);
    if (raw === null) continue;
    if (!isIsoDate(raw)) {
      fields[param] = ["Must be a calendar date, YYYY-MM-DD"];
      continue;
    }
    filter[key] = raw;
  }

  if (Object.keys(fields).length > 0) {
    return validationError(requestId, fields);
  }

  if (!(await allowed(env, actor, orgId, "expiry.item.read", requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const today = toIsoDate(deps?.now ? deps.now() : new Date());
  const executor = deps?.expiryRepo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = deps?.expiryRepo ?? createExpiryRepository(executor!);
    const result = await repo.listItemsPaged(orgId, filter, {
      limit: page.value.limit,
      cursor: page.value.cursor
        ? { createdAt: page.value.cursor.createdAt, id: page.value.cursor.id }
        : null,
    });
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }

    const items = result.value.items.map((item) => toPublicItem(item, today));
    const nextCursor = result.value.nextCursor
      ? encodeCursor(result.value.nextCursor.createdAt, result.value.nextCursor.id)
      : null;

    return Response.json(
      { data: { items }, meta: { requestId, cursor: nextCursor } },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
