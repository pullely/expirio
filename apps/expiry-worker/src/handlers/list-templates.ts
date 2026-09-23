import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { Uuid } from "@saas/db/ids";
import { allowed } from "../authz.js";
import { errorResponse, successResponse } from "../http.js";
import { TEMPLATE_CATALOG } from "../template-catalog.js";

/**
 * The catalogue is the same for every org, but it is still read behind
 * `expiry.item.read`: a non-member gets `not_found` for this org's path like
 * every other route in the context, so the path cannot be used as a probe.
 */
export async function handleListTemplates(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "expiry.item.read", requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  return successResponse({ templates: TEMPLATE_CATALOG }, requestId);
}
