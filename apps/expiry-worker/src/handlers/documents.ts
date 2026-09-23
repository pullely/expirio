import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { ExpiryRepository } from "@saas/db/expiry";
import type { EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import { EXPIRY_DOCUMENT_MAX_BYTES } from "@saas/contracts/expiry";
import { createExpiryRepository } from "@saas/db/expiry";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { allowed } from "../authz.js";
import { checkDocument, storeDocument, toPublicDocument } from "../documents.js";
import { errorResponse, successResponse, validationError } from "../http.js";
import { actorSubjectUuid } from "../ids.js";

export interface DocumentDeps {
  expiryRepo?: ExpiryRepository;
  eventsRepo?: EventsRepository;
  now?: () => Date;
  generateId?: () => string;
}

/**
 * `POST …/expiry-items/{id}/documents` — the body IS the file; its type is the
 * request's `content-type`, its name the `x-filename` header (or `?filename=`).
 * Proxied rather than presigned: authorization and the 10 MB / image-or-PDF
 * ceiling live here, and no storage credential ever reaches a browser.
 */
export async function handleUploadDocument(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  itemId: string,
  deps?: DocumentDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB || !env.DOCUMENTS) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > EXPIRY_DOCUMENT_MAX_BYTES) {
    return validationError(requestId, { file: [`Must be at most ${EXPIRY_DOCUMENT_MAX_BYTES} bytes`] });
  }
  if (!(await allowed(env, actor, orgId, "expiry.item.update", requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }

  const bytes = await request.arrayBuffer();
  const url = new URL(request.url);
  const check = checkDocument(
    request.headers.get("content-type"),
    bytes.byteLength,
    request.headers.get("x-filename") ?? url.searchParams.get("filename"),
  );
  if (!check.ok) return validationError(requestId, { [check.field]: [check.message] });

  const now = deps?.now ? deps.now() : new Date();
  const newId = deps?.generateId ?? (() => crypto.randomUUID());
  const executor = deps?.expiryRepo && deps?.eventsRepo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = deps?.expiryRepo ?? createExpiryRepository(executor!);
    const eventsRepo = deps?.eventsRepo ?? createEventsRepository(executor!);
    const item = await repo.getItemById(orgId, itemId);
    if (!item.ok) return errorResponse("not_found", "Not found", 404, requestId);

    const stored = await storeDocument({
      bucket: env.DOCUMENTS,
      repo,
      eventsRepo,
      orgId,
      itemId,
      itemName: item.value.name,
      projectId: item.value.projectId,
      bytes,
      contentType: check.contentType,
      filename: check.filename,
      source: "console",
      actor: { type: actor.subjectType, id: actor.subjectId, uuid: actorSubjectUuid(actor.subjectId) },
      requestId,
      now,
      newId,
    });
    if (!stored) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    return successResponse({ document: toPublicDocument(stored) }, requestId, 201);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

/** `GET …/expiry-items/{id}/documents` */
export async function handleListDocuments(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  itemId: string,
  deps?: DocumentDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, requestId);
  if (!(await allowed(env, actor, orgId, "expiry.item.read", requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  const executor = deps?.expiryRepo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = deps?.expiryRepo ?? createExpiryRepository(executor!);
    const item = await repo.getItemById(orgId, itemId);
    if (!item.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const docs = await repo.listDocuments(orgId, itemId);
    if (!docs.ok) return errorResponse("internal_error", "Service unavailable", 503, requestId);
    return successResponse({ documents: docs.value.map(toPublicDocument) }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

/**
 * `GET …/expiry-documents/{id}/content` — the bytes, streamed from R2. The row
 * lookup is scoped by org, so another org's document id is `not_found` before
 * R2 is touched; the object key is read from the row, never built from input.
 */
export async function handleDocumentContent(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: Uuid,
  documentId: string,
  deps?: DocumentDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB || !env.DOCUMENTS) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  if (!(await allowed(env, actor, orgId, "expiry.item.read", requestId))) {
    return errorResponse("not_found", "Not found", 404, requestId);
  }
  const executor = deps?.expiryRepo ? null : createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = deps?.expiryRepo ?? createExpiryRepository(executor!);
    const doc = await repo.getDocument(orgId, documentId);
    if (!doc.ok) return errorResponse("not_found", "Not found", 404, requestId);
    const object = await env.DOCUMENTS.get(doc.value.r2Key);
    if (!object) return errorResponse("not_found", "Not found", 404, requestId);
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type": doc.value.contentType,
        "content-length": String(doc.value.sizeBytes),
        "content-disposition": `attachment; filename="${doc.value.filename}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
        "x-request-id": requestId,
      },
    });
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
