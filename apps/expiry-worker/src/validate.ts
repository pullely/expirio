import { EXPIRY_ITEM_KINDS, type ExpiryItemKind } from "@saas/contracts/expiry";
import { isIsoDate } from "./ladder.js";

const NAME_MIN = 1;
const NAME_MAX = 160;
const TEXT_MAX = 200;
const NOTES_MAX = 2000;
const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

export interface ItemFields {
  name: string;
  kind: ExpiryItemKind;
  expiresOn: string;
  projectPublicId: string | null;
  issuer: string | null;
  identifier: string | null;
  holderName: string | null;
  holderEmail: string | null;
  managerEmail: string | null;
  issuedOn: string | null;
  notes: string | null;
  templateKey: string | null;
}

export type ValidationOutcome<T> =
  | { valid: true; value: T }
  | { valid: false; fields: Record<string, string[]> };

function optionalText(
  raw: unknown,
  field: string,
  max: number,
  fields: Record<string, string[]>,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    fields[field] = ["Must be a string or null"];
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    fields[field] = [`Must be at most ${max} characters`];
    return undefined;
  }
  return trimmed;
}

function optionalEmail(
  raw: unknown,
  field: string,
  fields: Record<string, string[]>,
): string | null | undefined {
  const value = optionalText(raw, field, TEXT_MAX, fields);
  if (value === undefined || value === null) return value;
  if (!EMAIL_RE.test(value)) {
    fields[field] = ["Must be an email address"];
    return undefined;
  }
  return value.toLowerCase();
}

function optionalDate(
  raw: unknown,
  field: string,
  fields: Record<string, string[]>,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string" || !isIsoDate(raw)) {
    fields[field] = ["Must be a calendar date, YYYY-MM-DD"];
    return undefined;
  }
  return raw;
}

/** The shared field rules. `partial` relaxes the two required fields for PATCH. */
export function validateItemBody(
  body: unknown,
  partial: boolean,
): ValidationOutcome<Partial<ItemFields>> {
  if (!body || typeof body !== "object") {
    return { valid: false, fields: { body: ["Request body must be an object"] } };
  }
  const req = body as Record<string, unknown>;
  const fields: Record<string, string[]> = {};
  const out: Partial<ItemFields> = {};

  if (req.name !== undefined || !partial) {
    if (
      typeof req.name !== "string" ||
      req.name.trim().length < NAME_MIN ||
      req.name.trim().length > NAME_MAX
    ) {
      fields.name = [`Must be a string between ${NAME_MIN} and ${NAME_MAX} characters`];
    } else {
      out.name = req.name.trim();
    }
  }

  if (req.expiresOn !== undefined || !partial) {
    if (typeof req.expiresOn !== "string" || !isIsoDate(req.expiresOn)) {
      fields.expiresOn = ["Must be a calendar date, YYYY-MM-DD"];
    } else {
      out.expiresOn = req.expiresOn;
    }
  }

  if (req.kind !== undefined) {
    if (typeof req.kind !== "string" || !EXPIRY_ITEM_KINDS.includes(req.kind as ExpiryItemKind)) {
      fields.kind = [`Must be one of: ${EXPIRY_ITEM_KINDS.join(", ")}`];
    } else {
      out.kind = req.kind as ExpiryItemKind;
    }
  } else if (!partial) {
    out.kind = "license";
  }

  const projectId = optionalText(req.projectId, "projectId", 64, fields);
  if (projectId !== undefined) out.projectPublicId = projectId;

  const issuer = optionalText(req.issuer, "issuer", TEXT_MAX, fields);
  if (issuer !== undefined) out.issuer = issuer;

  const identifier = optionalText(req.identifier, "identifier", TEXT_MAX, fields);
  if (identifier !== undefined) out.identifier = identifier;

  const holderName = optionalText(req.holderName, "holderName", TEXT_MAX, fields);
  if (holderName !== undefined) out.holderName = holderName;

  const templateKey = optionalText(req.templateKey, "templateKey", 64, fields);
  if (templateKey !== undefined) out.templateKey = templateKey;

  const notes = optionalText(req.notes, "notes", NOTES_MAX, fields);
  if (notes !== undefined) out.notes = notes;

  const holderEmail = optionalEmail(req.holderEmail, "holderEmail", fields);
  if (holderEmail !== undefined) out.holderEmail = holderEmail;

  const managerEmail = optionalEmail(req.managerEmail, "managerEmail", fields);
  if (managerEmail !== undefined) out.managerEmail = managerEmail;

  const issuedOn = optionalDate(req.issuedOn, "issuedOn", fields);
  if (issuedOn !== undefined) out.issuedOn = issuedOn;

  if (
    out.issuedOn &&
    out.expiresOn &&
    Date.parse(`${out.issuedOn}T00:00:00.000Z`) > Date.parse(`${out.expiresOn}T00:00:00.000Z`)
  ) {
    fields.issuedOn = ["Must not be after expiresOn"];
  }

  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return { valid: true, value: out };
}
