import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ExpiryRepository } from "@saas/db/expiry";
import type { Uuid } from "@saas/db/ids";
import { createExpiryRepository } from "@saas/db/expiry";
import { createSqlExecutor } from "@saas/db/d1";
import { allowed } from "../authz.js";
import { errorResponse, successResponse } from "../http.js";
import { toPublicReminder } from "../present.js";

export interface HandleListRemindersDeps {
  expiryRepo?: ExpiryRepository;
}

export async function handleListReminders(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  itemId: string,
  deps?: HandleListRemindersDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!(await allowed(env, actor, orgId, "expiry.item.read", requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const executor = deps?.expiryRepo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = deps?.expiryRepo ?? createExpiryRepository(executor!);

    // The item read is the tenancy check: a reminder list for an item this org
    // does not own is `not_found`, not an empty array.
    const item = await repo.getItemById(orgId, itemId);
    if (!item.ok) {
      return errorResponse("not_found", "Not found", 404, requestId);
    }

    const result = await repo.listRemindersForItem(orgId, itemId);
    if (!result.ok) {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
    return successResponse({ reminders: result.value.map(toPublicReminder) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
