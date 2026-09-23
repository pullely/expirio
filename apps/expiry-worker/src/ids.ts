import { isUuid, uuidFromPublicId, uuidToHex, type Uuid } from "@saas/db/ids";

export function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return `req_${hex}`;
}

export function orgPublicId(uuid: string): string {
  return `org_${uuidToHex(uuid)}`;
}

export function parseOrgPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "org");
}

export function projectPublicId(uuid: string): string {
  return `prj_${uuidToHex(uuid)}`;
}

export function parseProjectPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "prj");
}

export function expiryItemPublicId(uuid: string): string {
  return `exi_${uuidToHex(uuid)}`;
}

export function parseExpiryItemPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "exi");
}

export function expiryReminderPublicId(uuid: string): string {
  return `exr_${uuidToHex(uuid)}`;
}

export function parseExpiryReminderPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "exr");
}

/**
 * The actor id in the shape a UUID column will take.
 *
 * `api-edge` forwards a raw UUID in `x-actor-subject-id` today — that is why
 * membership-worker compares it to `subject_id` directly — but `created_by` is
 * a UUID column, and a public id (`usr_<hex>`) arriving there verbatim would be
 * an unreadable row nothing could join on. So decode when it looks like a
 * public id, pass a UUID through, and refuse anything else by writing null
 * rather than garbage.
 */
export function actorSubjectUuid(subjectId: string): string | null {
  if (isUuid(subjectId)) return subjectId;
  return uuidFromPublicId(subjectId);
}

export function expiryDocumentPublicId(uuid: string): string {
  return `exd_${uuidToHex(uuid)}`;
}

export function parseExpiryDocumentPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "exd");
}

export function expiryLinkPublicId(uuid: string): string {
  return `exl_${uuidToHex(uuid)}`;
}

export function expiryFeedPublicId(uuid: string): string {
  return `exf_${uuidToHex(uuid)}`;
}

export function parseExpiryFeedPublicId(publicId: string): Uuid | null {
  return uuidFromPublicId(publicId, "exf");
}
