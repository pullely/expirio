import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";
import { enforceRateLimit, mergeRateLimitHeaders } from "./rate-limit.js";

const ORG_ITEMS_RE = /^\/v1\/organizations\/[^/]+\/expiry-items$/;
const ORG_ITEM_ID_RE = /^\/v1\/organizations\/[^/]+\/expiry-items\/[^/]+$/;
const ORG_ITEM_RENEW_RE = /^\/v1\/organizations\/[^/]+\/expiry-items\/[^/]+\/renew$/;
const ORG_ITEM_REMINDERS_RE = /^\/v1\/organizations\/[^/]+\/expiry-items\/[^/]+\/reminders$/;
const ORG_TEMPLATES_RE = /^\/v1\/organizations\/[^/]+\/expiry-templates$/;
const ORG_TEMPLATE_APPLY_RE = /^\/v1\/organizations\/[^/]+\/expiry-templates\/[^/]+\/apply$/;
const ORG_SCORECARD_RE = /^\/v1\/organizations\/[^/]+\/expiry-scorecard$/;
const ORG_ITEM_DOCUMENTS_RE = /^\/v1\/organizations\/[^/]+\/expiry-items\/[^/]+\/documents$/;
const ORG_ITEM_LINKS_RE = /^\/v1\/organizations\/[^/]+\/expiry-items\/[^/]+\/renewal-links$/;
const ORG_DOCUMENT_CONTENT_RE = /^\/v1\/organizations\/[^/]+\/expiry-documents\/[^/]+\/content$/;
const ORG_FEEDS_RE = /^\/v1\/organizations\/[^/]+\/expiry-feeds$/;
const ORG_FEED_ID_RE = /^\/v1\/organizations\/[^/]+\/expiry-feeds\/[^/]+$/;

// EX3 public ingress: three exact paths, no session. The bearer token in the
// query (or the form) is verified inside expiry-worker by hash lookup — the
// edge rate-limits and forwards, it never holds a verifier.
const PUBLIC_RENEW_PATH = "/ingress/expirio/renew";
const PUBLIC_CALENDAR_PATH = "/ingress/expirio/calendar.ics";

const FORWARDED_HEADERS = [
  "content-type",
  "content-length",
  "x-request-id",
  "traceparent",
  "idempotency-key",
  "x-filename",
];

const BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);

export function isExpiryRoute(pathname: string): boolean {
  return (
    ORG_ITEMS_RE.test(pathname) ||
    ORG_ITEM_RENEW_RE.test(pathname) ||
    ORG_ITEM_REMINDERS_RE.test(pathname) ||
    ORG_ITEM_ID_RE.test(pathname) ||
    ORG_ITEM_DOCUMENTS_RE.test(pathname) ||
    ORG_ITEM_LINKS_RE.test(pathname) ||
    ORG_DOCUMENT_CONTENT_RE.test(pathname) ||
    ORG_FEEDS_RE.test(pathname) ||
    ORG_FEED_ID_RE.test(pathname) ||
    ORG_TEMPLATES_RE.test(pathname) ||
    ORG_TEMPLATE_APPLY_RE.test(pathname) ||
    ORG_SCORECARD_RE.test(pathname)
  );
}

function methodAllowed(pathname: string, method: string): boolean {
  // Ordered like `isExpiryRoute`: the two-segment `.../{id}` pattern also
  // matches `/renew` and `/reminders`, so those are decided first.
  if (ORG_ITEMS_RE.test(pathname)) return method === "POST" || method === "GET";
  if (ORG_ITEM_RENEW_RE.test(pathname)) return method === "POST";
  if (ORG_ITEM_REMINDERS_RE.test(pathname)) return method === "GET";
  if (ORG_ITEM_DOCUMENTS_RE.test(pathname)) return method === "POST" || method === "GET";
  if (ORG_ITEM_LINKS_RE.test(pathname)) return method === "POST";
  if (ORG_DOCUMENT_CONTENT_RE.test(pathname)) return method === "GET";
  if (ORG_FEEDS_RE.test(pathname)) return method === "POST" || method === "GET";
  if (ORG_FEED_ID_RE.test(pathname)) return method === "DELETE";
  if (ORG_TEMPLATES_RE.test(pathname)) return method === "GET";
  if (ORG_TEMPLATE_APPLY_RE.test(pathname)) return method === "POST";
  if (ORG_SCORECARD_RE.test(pathname)) return method === "GET";
  if (ORG_ITEM_ID_RE.test(pathname)) {
    return method === "GET" || method === "PATCH" || method === "DELETE";
  }
  return false;
}

export async function handleExpiryRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  if (!methodAllowed(pathname, request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  return replayOrExecute(request, requestId, env, "expiry", async () => {
    if (!env.IDENTITY_WORKER) {
      return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
    }
    if (!env.EXPIRY_WORKER) {
      return errorResponse("internal_error", "Expiry service unavailable", 503, requestId);
    }

    const timings = createTimings();
    const endTotal = timings.start("edge_total");
    const sessionResult = await timings.measure("edge_auth", () =>
      resolveActor(request, env, requestId),
    );
    if ("error" in sessionResult) {
      return sessionResult.error;
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-actor-subject-id", sessionResult.subjectId);
    headers.set("x-actor-subject-type", sessionResult.subjectType);
    headers.set("x-actor-email", sessionResult.email);
    for (const name of FORWARDED_HEADERS) {
      if (name === "x-request-id") continue;
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://expiry.internal");

    const init: RequestInit = { method: request.method, headers };
    if (BODY_METHODS.has(request.method)) {
      init.body = request.body;
    }

    try {
      const downstream = await timings.measure("edge_downstream", () =>
        env.EXPIRY_WORKER!.fetch(target.toString(), init),
      );
      const res = new Response(downstream.body, {
        status: downstream.status,
        headers: downstream.headers,
      });
      endTotal();
      return withEdgeTimings(res, requestId, "edge.expiry", timings);
    } catch {
      return errorResponse("internal_error", "Expiry service unavailable", 503, requestId);
    }
  });
}

export function isExpiryIngressRoute(pathname: string): boolean {
  return pathname === PUBLIC_RENEW_PATH || pathname === PUBLIC_CALENDAR_PATH;
}

/**
 * The renewal link and the calendar feed. Allow-listed in index.ts BEFORE the
 * authenticated facades; no actor is resolved and no actor header is set, so
 * expiry-worker can only treat the request as a bearer-token call.
 */
export async function handleExpiryIngressRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  const allowedMethod =
    pathname === PUBLIC_CALENDAR_PATH
      ? request.method === "GET"
      : request.method === "GET" || request.method === "POST";
  if (!allowedMethod) return errorResponse("unsupported", "Method not allowed", 405, requestId);
  if (!env.EXPIRY_WORKER) {
    return errorResponse("internal_error", "Expiry service unavailable", 503, requestId);
  }
  const rateDecision = await enforceRateLimit(request, requestId, env, "expiry");
  if (rateDecision.kind === "denied") return rateDecision.response;

  const headers = new Headers();
  headers.set("x-request-id", requestId);
  headers.set("x-internal-caller", "api-edge");
  for (const name of ["content-type", "content-length"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const url = new URL(request.url);
  const target = new URL(pathname + url.search, "https://expiry.internal");
  const init: RequestInit = { method: request.method, headers };
  if (request.method === "POST") init.body = request.body;
  try {
    const downstream = await env.EXPIRY_WORKER.fetch(target.toString(), init);
    return mergeRateLimitHeaders(
      new Response(downstream.body, { status: downstream.status, headers: downstream.headers }),
      rateDecision.headers,
    );
  } catch {
    return errorResponse("internal_error", "Expiry service unavailable", 503, requestId);
  }
}
