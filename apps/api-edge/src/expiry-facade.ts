import type { Env } from "./env.js";
import { errorResponse, withEdgeTimings } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";
import { createTimings } from "@saas/contracts/timing";

const ORG_ITEMS_RE = /^\/v1\/organizations\/[^/]+\/expiry-items$/;
const ORG_ITEM_ID_RE = /^\/v1\/organizations\/[^/]+\/expiry-items\/[^/]+$/;
const ORG_ITEM_RENEW_RE = /^\/v1\/organizations\/[^/]+\/expiry-items\/[^/]+\/renew$/;
const ORG_ITEM_REMINDERS_RE = /^\/v1\/organizations\/[^/]+\/expiry-items\/[^/]+\/reminders$/;

const FORWARDED_HEADERS = ["content-type", "x-request-id", "traceparent", "idempotency-key"];

const BODY_METHODS = new Set(["POST", "PATCH", "PUT"]);

export function isExpiryRoute(pathname: string): boolean {
  return (
    ORG_ITEMS_RE.test(pathname) ||
    ORG_ITEM_RENEW_RE.test(pathname) ||
    ORG_ITEM_REMINDERS_RE.test(pathname) ||
    ORG_ITEM_ID_RE.test(pathname)
  );
}

function methodAllowed(pathname: string, method: string): boolean {
  // Ordered like `isExpiryRoute`: the two-segment `.../{id}` pattern also
  // matches `/renew` and `/reminders`, so those are decided first.
  if (ORG_ITEMS_RE.test(pathname)) return method === "POST" || method === "GET";
  if (ORG_ITEM_RENEW_RE.test(pathname)) return method === "POST";
  if (ORG_ITEM_REMINDERS_RE.test(pathname)) return method === "GET";
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
