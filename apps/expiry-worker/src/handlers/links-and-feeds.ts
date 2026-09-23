import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ExpiryFeedToken, ExpiryRepository } from "@saas/db/expiry";
import type { EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import {
  EXPIRY_RENEWAL_LINK_TTL_DAYS,
  type PublicExpiryFeed,
} from "@saas/contracts/expiry";
import { createExpiryRepository } from "@saas/db/expiry";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { allowed } from "../authz.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import {
  actorSubjectUuid,
  expiryFeedPublicId,
  expiryItemPublicId,
  expiryLinkPublicId,
  orgPublicId,
  parseProjectPublicId,
  projectPublicId,
} from "../ids.js";
import { FEED_TOKEN_PREFIX, RENEWAL_TOKEN_PREFIX, mintToken } from "../tokens.js";

const DAY_MS = 86_400_000;

export interface LinksFeedsDeps {
  expiryRepo?: ExpiryRepository;
  eventsRepo?: EventsRepository;
  now?: () => Date;
  generateId?: () => string;
}

export function toPublicFeed(f: ExpiryFeedToken): PublicExpiryFeed {
  return {
    id: expiryFeedPublicId(f.id),
    orgId: orgPublicId(f.orgId),
    projectId: f.projectId ? projectPublicId(f.projectId) : null,
    label: f.label,
    revokedAt: f.revokedAt ? f.revokedAt.toISOString() : null,
    lastUsedAt: f.lastUsedAt ? f.lastUsedAt.toISOString() : null,
    createdAt: f.createdAt.toISOString(),
  };
}

function repos(env: Env, deps?: LinksFeedsDeps) {
  const executor = deps?.expiryRepo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB!);
  return {
    executor,
    repo: deps?.expiryRepo ?? createExpiryRepository(executor!),
    eventsRepo: deps?.eventsRepo ?? createEventsRepository(executor!),
  };
}

/**
 * `POST …/expiry-items/{id}/renewal-links` — mint a single-use, 14-day link a
 * holder renews from without an account. Authorized as `expiry.item.renew`:
 * handing someone the ability to renew is renewing by proxy.
 */
export async function handleCreateRenewalLink(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  itemId: string,
  deps?: LinksFeedsDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!(await allowed(env, actor, orgId, "expiry.item.renew", requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  const now = deps?.now ? deps.now() : new Date();
  const newId = deps?.generateId ?? (() => crypto.randomUUID());
  const { executor, repo, eventsRepo } = repos(env, deps);
  try {
    const item = await repo.getItemById(orgId, itemId);
    if (!item.ok || item.value.status === "archived") {
      return errorResponse("not_found", "Not found", 404, requestId);
    }
    const token = await mintToken(RENEWAL_TOKEN_PREFIX);
    const link = await repo.createRenewalLink({
      id: newId(),
      orgId,
      itemId,
      tokenHash: token.hash,
      createdBy: actorSubjectUuid(actor.subjectId),
      expiresAt: new Date(now.getTime() + EXPIRY_RENEWAL_LINK_TTL_DAYS * DAY_MS),
      createdAt: now,
    });
    if (!link.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    await eventsRepo.appendEventWithAudit({
      event: {
        id: newId(),
        type: "expiry.renewal_link.created",
        version: 1,
        source: "expiry-worker",
        occurredAt: now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: item.value.projectId,
        subjectKind: "expiry_item",
        subjectId: itemId,
        subjectName: item.value.name,
        requestId,
        payload: {
          itemId: expiryItemPublicId(itemId),
          linkId: expiryLinkPublicId(link.value.id),
          expiresAt: link.value.expiresAt.toISOString(),
        },
      },
      audit: {
        id: newId(),
        category: "expiry",
        description: `Minted a ${EXPIRY_RENEWAL_LINK_TTL_DAYS}-day renewal link for "${item.value.name}"`,
        projectId: item.value.projectId,
      },
    });
    return successResponse(
      {
        link: {
          id: expiryLinkPublicId(link.value.id),
          itemId: expiryItemPublicId(itemId),
          expiresAt: link.value.expiresAt.toISOString(),
          consumedAt: null,
          createdAt: link.value.createdAt.toISOString(),
        },
        token: token.raw,
        path: `/renew?token=${token.raw}`,
      },
      requestId,
      201,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

/**
 * Feed tokens are org administration, so they sit behind `expiry.item.delete`
 * — the admin/owner action in the policy tables — rather than a new
 * `expiry.feed.manage` action that would force a policy-worker redeploy.
 */
const FEED_ACTION = "expiry.item.delete";

export async function handleCreateFeed(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: LinksFeedsDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return validationError(requestId, { body: ["Invalid JSON"] });
  }
  const fields: Record<string, string[]> = {};
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (label.length < 1 || label.length > 80) fields.label = ["Must be 1 to 80 characters"];
  let projectUuid: string | null = null;
  if (body.projectId !== undefined && body.projectId !== null) {
    projectUuid = typeof body.projectId === "string" ? parseProjectPublicId(body.projectId) : null;
    if (!projectUuid) fields.projectId = ["Not a project id"];
  }
  if (Object.keys(fields).length > 0) return validationError(requestId, fields);

  if (!(await allowed(env, actor, orgId, FEED_ACTION, requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  const now = deps?.now ? deps.now() : new Date();
  const newId = deps?.generateId ?? (() => crypto.randomUUID());
  const { executor, repo, eventsRepo } = repos(env, deps);
  try {
    const token = await mintToken(FEED_TOKEN_PREFIX);
    const feed = await repo.createFeedToken({
      id: newId(),
      orgId,
      projectId: projectUuid,
      label,
      tokenHash: token.hash,
      createdBy: actorSubjectUuid(actor.subjectId),
      createdAt: now,
    });
    if (!feed.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    await eventsRepo.appendEventWithAudit({
      event: {
        id: newId(),
        type: "expiry.feed.created",
        version: 1,
        source: "expiry-worker",
        occurredAt: now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        projectId: projectUuid,
        subjectKind: "expiry_feed",
        subjectId: feed.value.id,
        subjectName: label,
        requestId,
        payload: { feedId: expiryFeedPublicId(feed.value.id), label },
      },
      audit: { id: newId(), category: "expiry", description: `Created calendar feed "${label}"`, projectId: projectUuid },
    });
    return successResponse(
      {
        feed: toPublicFeed(feed.value),
        token: token.raw,
        path: `/ingress/expirio/calendar.ics?token=${token.raw}`,
      },
      requestId,
      201,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

export async function handleListFeeds(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  deps?: LinksFeedsDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!(await allowed(env, actor, orgId, FEED_ACTION, requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  const { executor, repo } = repos(env, deps);
  try {
    const feeds = await repo.listFeedTokens(orgId);
    if (!feeds.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    return successResponse({ feeds: feeds.value.map(toPublicFeed) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

export async function handleRevokeFeed(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  feedId: string,
  deps?: LinksFeedsDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!(await allowed(env, actor, orgId, FEED_ACTION, requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  const now = deps?.now ? deps.now() : new Date();
  const newId = deps?.generateId ?? (() => crypto.randomUUID());
  const { executor, repo, eventsRepo } = repos(env, deps);
  try {
    const revoked = await repo.revokeFeedToken(orgId, feedId, now);
    if (!revoked.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    if (!revoked.value) return errorResponse("not_found", "Not found", 404, requestId);
    await eventsRepo.appendEventWithAudit({
      event: {
        id: newId(),
        type: "expiry.feed.revoked",
        version: 1,
        source: "expiry-worker",
        occurredAt: now,
        actorType: actor.subjectType,
        actorId: actor.subjectId,
        orgId,
        subjectKind: "expiry_feed",
        subjectId: feedId,
        requestId,
        payload: { feedId: expiryFeedPublicId(feedId) },
      },
      audit: { id: newId(), category: "expiry", description: "Revoked a calendar feed" },
    });
    return successResponse({ feed: { id: expiryFeedPublicId(feedId), revoked: true } }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
