import type { Env } from "../env.js";
import type { ExpiryRepository } from "@saas/db/expiry";
import type { EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import {
  EXPIRY_DOCUMENT_CONTENT_TYPES,
  EXPIRY_DOCUMENT_MAX_BYTES,
  type PublicExpiryItem,
} from "@saas/contracts/expiry";
import { createExpiryRepository } from "@saas/db/expiry";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { checkDocument, storeDocument } from "../documents.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { expiryLinkPublicId } from "../ids.js";
import { renderIcs } from "../ics.js";
import { daysBetween, isIsoDate, shiftDate, toIsoDate } from "../ladder.js";
import { applyRenewal } from "../renewal.js";
import { FEED_TOKEN_PREFIX, RENEWAL_TOKEN_PREFIX, isWellFormedToken, sha256Hex } from "../tokens.js";

export const RENEW_PATH = "/ingress/expirio/renew";
export const CALENDAR_PATH = "/ingress/expirio/calendar.ics";

/** The feed looks back a week (so a just-lapsed item stays visible) and returns at most this many. */
export const FEED_LOOKBACK_DAYS = 7;
export const FEED_LIMIT = 500;

export interface PublicDeps {
  expiryRepo?: ExpiryRepository;
  eventsRepo?: EventsRepository;
  now?: () => Date;
  generateId?: () => string;
}

/** The one answer every bad, spent, expired or revoked token gets. */
function gone(requestId: string): Response {
  return errorResponse("not_found", "This link is not valid any more", 404, requestId);
}

/**
 * The three public paths. There is no actor: the bearer token IS the
 * authorization, verified here by hashing it and looking the row up. The edge
 * only rate-limits and forwards.
 */
export async function routePublicIngress(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
  deps?: PublicDeps,
): Promise<Response> {
  if (pathname === RENEW_PATH) {
    if (request.method === "GET") return handleRenewForm(request, env, requestId, deps);
    if (request.method === "POST") return handleRenewSubmit(request, env, requestId, deps);
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }
  if (pathname === CALENDAR_PATH) {
    if (request.method !== "GET") return errorResponse("unsupported", "Method not allowed", 405, requestId);
    return handleCalendar(request, env, requestId, deps);
  }
  return errorResponse("not_found", "Not found", 404, requestId);
}

async function withRepos<T>(
  env: Env,
  deps: PublicDeps | undefined,
  fn: (repo: ExpiryRepository, eventsRepo: EventsRepository) => Promise<T>,
): Promise<T> {
  const executor = deps?.expiryRepo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await fn(
      deps?.expiryRepo ?? createExpiryRepository(executor!),
      deps?.eventsRepo ?? createEventsRepository(executor!),
    );
  } finally {
    if (executor) await executor.dispose();
  }
}

async function handleRenewForm(
  request: Request,
  env: Env,
  requestId: string,
  deps?: PublicDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const token = new URL(request.url).searchParams.get("token");
  if (!isWellFormedToken(token, RENEWAL_TOKEN_PREFIX)) return gone(requestId);
  const now = deps?.now ? deps.now() : new Date();
  try {
    return await withRepos(env, deps, async (repo) => {
      const link = await repo.findRenewalLinkByHash(await sha256Hex(token), now);
      if (!link.ok) return gone(requestId);
      const item = await repo.getItemById(link.value.orgId as Uuid, link.value.itemId);
      if (!item.ok || item.value.status === "archived") return gone(requestId);
      // Name, kind, issuer, holder, date. Not the number, not an email, not an id.
      return successResponse(
        {
          item: {
            name: item.value.name,
            kind: item.value.kind as PublicExpiryItem["kind"],
            issuer: item.value.issuer,
            holderName: item.value.holderName,
            expiresOn: item.value.expiresOn,
          },
          linkExpiresAt: link.value.expiresAt.toISOString(),
          maxDocumentBytes: EXPIRY_DOCUMENT_MAX_BYTES,
          acceptedContentTypes: EXPIRY_DOCUMENT_CONTENT_TYPES,
        },
        requestId,
      );
    });
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}

interface RenewSubmission {
  token: string | null;
  expiresOn: unknown;
  file: File | null;
}

async function readSubmission(request: Request): Promise<RenewSubmission | null> {
  const queryToken = new URL(request.url).searchParams.get("token");
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (type.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      const formToken = form.get("token");
      return {
        token: queryToken ?? (typeof formToken === "string" ? formToken : null),
        expiresOn: form.get("expiresOn"),
        file: file && typeof file !== "string" && (file as File).size > 0 ? (file as File) : null,
      };
    }
    const body = ((await request.json()) ?? {}) as Record<string, unknown>;
    return {
      token: queryToken ?? (typeof body.token === "string" ? body.token : null),
      expiresOn: body.expiresOn,
      file: null,
    };
  } catch {
    return null;
  }
}

/**
 * `POST /ingress/expirio/renew` — JSON `{ token, expiresOn }` or multipart with
 * `token`, `expiresOn` and an optional `file`. Everything is validated BEFORE
 * the link is consumed, so a typo does not burn the holder's only link; the
 * consume itself is the atomic single use.
 */
async function handleRenewSubmit(
  request: Request,
  env: Env,
  requestId: string,
  deps?: PublicDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > EXPIRY_DOCUMENT_MAX_BYTES + 64 * 1024) {
    return validationError(requestId, { file: [`Must be at most ${EXPIRY_DOCUMENT_MAX_BYTES} bytes`] });
  }
  const sub = await readSubmission(request);
  if (!sub) return validationError(requestId, { body: ["Send JSON or multipart/form-data"] });
  if (!isWellFormedToken(sub.token, RENEWAL_TOKEN_PREFIX)) return gone(requestId);

  const now = deps?.now ? deps.now() : new Date();
  const today = toIsoDate(now);
  if (typeof sub.expiresOn !== "string" || !isIsoDate(sub.expiresOn)) {
    return validationError(requestId, { expiresOn: ["Must be a calendar date, YYYY-MM-DD"] });
  }
  if (daysBetween(today, sub.expiresOn) <= 0) {
    return validationError(requestId, { expiresOn: ["Must be after today"] });
  }
  const expiresOn = sub.expiresOn;

  let fileBytes: ArrayBuffer | null = null;
  let fileCheck: ReturnType<typeof checkDocument> | null = null;
  if (sub.file) {
    if (!env.DOCUMENTS) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    fileBytes = await sub.file.arrayBuffer();
    fileCheck = checkDocument(sub.file.type, fileBytes.byteLength, sub.file.name);
    if (!fileCheck.ok) return validationError(requestId, { [fileCheck.field]: [fileCheck.message] });
  }

  const newId = deps?.generateId ?? (() => crypto.randomUUID());
  try {
    return await withRepos(env, deps, async (repo, eventsRepo) => {
      const link = await repo.findRenewalLinkByHash(await sha256Hex(sub.token!), now);
      if (!link.ok) return gone(requestId);
      const orgId = link.value.orgId as Uuid;
      const consumed = await repo.consumeRenewalLink(link.value.id, now);
      if (!consumed.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
      if (!consumed.value) return gone(requestId);

      const linkActor = { type: "renewal_link", id: expiryLinkPublicId(link.value.id) };
      const renewed = await applyRenewal({
        repo,
        eventsRepo,
        orgId,
        itemId: link.value.itemId,
        expiresOn,
        actor: linkActor,
        via: "renewal_link",
        requestId,
        now,
        today,
        newId,
      });
      if (!renewed.ok) {
        return renewed.kind === "not_found"
          ? gone(requestId)
          : errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      let documentAttached = false;
      if (fileBytes && fileCheck?.ok && env.DOCUMENTS) {
        const stored = await storeDocument({
          bucket: env.DOCUMENTS,
          repo,
          eventsRepo,
          orgId,
          itemId: link.value.itemId,
          itemName: renewed.item.name,
          projectId: renewed.item.projectId,
          bytes: fileBytes,
          contentType: fileCheck.contentType,
          filename: fileCheck.filename,
          source: "renewal_link",
          actor: { ...linkActor, uuid: null },
          requestId,
          now,
          newId,
        });
        documentAttached = stored !== null;
      }
      return successResponse({ renewed: true, expiresOn, documentAttached }, requestId);
    });
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}

/** `GET /ingress/expirio/calendar.ics?token=` — the location's (or org's) upcoming expiries. */
async function handleCalendar(
  request: Request,
  env: Env,
  requestId: string,
  deps?: PublicDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  const token = new URL(request.url).searchParams.get("token");
  if (!isWellFormedToken(token, FEED_TOKEN_PREFIX)) return gone(requestId);
  const now = deps?.now ? deps.now() : new Date();
  try {
    return await withRepos(env, deps, async (repo) => {
      const feed = await repo.findFeedTokenByHash(await sha256Hex(token));
      if (!feed.ok) return gone(requestId);
      const from = shiftDate(toIsoDate(now), -FEED_LOOKBACK_DAYS);
      const entries = await repo.listFeedEntries(feed.value.orgId, feed.value.projectId, from, FEED_LIMIT);
      if (!entries.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
      await repo.touchFeedToken(feed.value.id, now);
      return new Response(renderIcs(`Expirio — ${feed.value.label}`, entries.value, now), {
        status: 200,
        headers: {
          "content-type": "text/calendar; charset=utf-8",
          "content-disposition": 'inline; filename="expirio.ics"',
          "cache-control": "private, max-age=300",
          "x-request-id": requestId,
        },
      });
    });
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
