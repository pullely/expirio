import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ExpiryRepository, ScorecardRow } from "@saas/db/expiry";
import type { Uuid } from "@saas/db/ids";
import type { GetExpiryScorecardResponse, PublicExpiryScorecardRow } from "@saas/contracts/expiry";
import { createExpiryRepository } from "@saas/db/expiry";
import { createSqlExecutor } from "@saas/db/d1";
import { allowed } from "../authz.js";
import { errorResponse, successResponse } from "../http.js";
import { projectPublicId } from "../ids.js";
import { shiftDate, toIsoDate } from "../ladder.js";

export const SCORECARD_HORIZON_DAYS = 30;

export interface HandleScorecardDeps {
  expiryRepo?: ExpiryRepository;
  now?: () => Date;
}

function compliant(total: number, expired: number): number {
  if (total === 0) return 100;
  return Math.round(((total - expired) / total) * 1000) / 10;
}

/** Shape the SQL aggregate for the wire, and total it. Pure — unit-tested. */
export function buildScorecard(rows: ScorecardRow[], asOf: string): GetExpiryScorecardResponse {
  const locations: PublicExpiryScorecardRow[] = rows.map((r) => ({
    projectId: r.projectId ? projectPublicId(r.projectId) : null,
    total: r.total,
    active: r.active,
    expiring: r.expiring,
    expired: r.expired,
    renewed: r.renewed,
    dueWithin30: r.dueWithin30,
    compliantPercent: compliant(r.total, r.expired),
  }));
  const sum = (k: keyof ScorecardRow) => rows.reduce((n, r) => n + (r[k] as number), 0);
  const total = sum("total");
  const expired = sum("expired");
  return {
    asOf,
    horizonDays: SCORECARD_HORIZON_DAYS,
    totals: {
      total,
      active: sum("active"),
      expiring: sum("expiring"),
      expired,
      renewed: sum("renewed"),
      dueWithin30: sum("dueWithin30"),
      compliantPercent: compliant(total, expired),
    },
    locations,
  };
}

/** Compliance per location — aggregated in SQL, never in the console. */
export async function handleScorecard(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: HandleScorecardDeps,
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
    const result = await repo.scorecard(orgId, today, shiftDate(today, SCORECARD_HORIZON_DAYS));
    if (!result.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    return successResponse(buildScorecard(result.value, today), requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
