import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ExpiryRepository } from "@saas/db/expiry";
import type { Uuid } from "@saas/db/ids";
import { createExpiryRepository } from "@saas/db/expiry";
import { createSqlExecutor } from "@saas/db/d1";
import { allowed } from "../authz.js";
import { errorResponse, successResponse } from "../http.js";
import { toIsoDate } from "../ladder.js";
import { toPublicItem } from "../present.js";

export interface HandleGetItemDeps {
  expiryRepo?: ExpiryRepository;
  now?: () => Date;
}

export async function handleGetItem(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  itemId: string,
  deps?: HandleGetItemDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!(await allowed(env, actor, orgId, "expiry.item.read", requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const today = toIsoDate(deps?.now ? deps.now() : new Date());
  const executor = deps?.expiryRepo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = deps?.expiryRepo ?? createExpiryRepository(executor!);
    const result = await repo.getItemById(orgId, itemId);
    if (!result.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }
    return successResponse({ item: toPublicItem(result.value, today) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
