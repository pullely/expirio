import {
  EXPIRY_DOCUMENT_CONTENT_TYPES,
  EXPIRY_DOCUMENT_MAX_BYTES,
  type PublicExpiryDocument,
} from "@saas/contracts/expiry";
import type { ExpiryDocument, ExpiryRepository } from "@saas/db/expiry";
import type { EventsRepository } from "@saas/db/events";
import type { Uuid } from "@saas/db/ids";
import { expiryDocumentPublicId, expiryItemPublicId, orgPublicId } from "./ids.js";
import { sha256Hex } from "./tokens.js";

export type DocumentCheck =
  | { ok: true; contentType: string; filename: string }
  | { ok: false; field: string; message: string };

/** Strip a path, control characters and quotes; keep it short. Never trusted for the key. */
export function safeFilename(raw: string | null | undefined): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim().slice(0, 120);
  return cleaned.length > 0 ? cleaned : "document";
}

/** The 10 MB, image-or-PDF ceiling. */
export function checkDocument(
  contentType: string | null | undefined,
  sizeBytes: number,
  filename: string | null | undefined,
): DocumentCheck {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(EXPIRY_DOCUMENT_CONTENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, field: "contentType", message: `Must be one of: ${EXPIRY_DOCUMENT_CONTENT_TYPES.join(", ")}` };
  }
  if (sizeBytes <= 0) return { ok: false, field: "file", message: "The file is empty" };
  if (sizeBytes > EXPIRY_DOCUMENT_MAX_BYTES) {
    return { ok: false, field: "file", message: `Must be at most ${EXPIRY_DOCUMENT_MAX_BYTES} bytes` };
  }
  return { ok: true, contentType: type, filename: safeFilename(filename) };
}

/** `<org_uuid>/<item_uuid>/<document_uuid>` — the tenant is in the key. */
export function documentKey(orgId: string, itemId: string, documentId: string): string {
  return `${orgId}/${itemId}/${documentId}`;
}

export function toPublicDocument(d: ExpiryDocument): PublicExpiryDocument {
  return {
    id: expiryDocumentPublicId(d.id),
    orgId: orgPublicId(d.orgId),
    itemId: expiryItemPublicId(d.itemId),
    filename: d.filename,
    contentType: d.contentType,
    sizeBytes: d.sizeBytes,
    sha256: d.sha256,
    source: d.source as PublicExpiryDocument["source"],
    uploadedAt: d.uploadedAt.toISOString(),
  };
}

export interface StoreDocumentInput {
  bucket: R2Bucket;
  repo: ExpiryRepository;
  eventsRepo: EventsRepository;
  orgId: Uuid;
  itemId: string;
  itemName: string;
  projectId: string | null;
  bytes: ArrayBuffer;
  contentType: string;
  filename: string;
  source: "console" | "renewal_link";
  actor: { type: string; id: string; uuid: string | null };
  requestId: string;
  now: Date;
  newId: () => string;
}

/**
 * Bytes to R2 first, then the row, then the event. A row never points at an
 * object that is not there; an orphaned object (row write failed) is harmless
 * and unreachable, because every read goes through the row.
 */
export async function storeDocument(input: StoreDocumentInput): Promise<ExpiryDocument | null> {
  const documentId = input.newId();
  const key = documentKey(input.orgId, input.itemId, documentId);
  const sha256 = await sha256Hex(input.bytes);
  await input.bucket.put(key, input.bytes, {
    httpMetadata: { contentType: input.contentType },
    customMetadata: { sha256, filename: input.filename },
  });
  const row = await input.repo.createDocument({
    id: documentId,
    orgId: input.orgId,
    itemId: input.itemId,
    r2Key: key,
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.bytes.byteLength,
    sha256,
    source: input.source,
    uploadedBy: input.actor.uuid,
    uploadedAt: input.now,
  });
  if (!row.ok) return null;
  await input.eventsRepo.appendEventWithAudit({
    event: {
      id: input.newId(),
      type: "expiry.document.attached",
      version: 1,
      source: "expiry-worker",
      occurredAt: input.now,
      actorType: input.actor.type,
      actorId: input.actor.id,
      orgId: input.orgId,
      projectId: input.projectId,
      subjectKind: "expiry_item",
      subjectId: input.itemId,
      subjectName: input.itemName,
      requestId: input.requestId,
      payload: {
        itemId: expiryItemPublicId(input.itemId),
        documentId: expiryDocumentPublicId(documentId),
        orgId: orgPublicId(input.orgId),
        contentType: input.contentType,
        sizeBytes: input.bytes.byteLength,
        source: input.source,
      },
    },
    audit: {
      id: input.newId(),
      category: "expiry",
      description: `Attached "${input.filename}" to "${input.itemName}"`,
      projectId: input.projectId,
    },
  });
  return row.value;
}
