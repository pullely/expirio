/**
 * Expiry bounded context — the tracked item and its materialised reminder
 * ladder. A cirrus project is the LOCATION an item belongs to; `projectId` is
 * null for an organization-wide item.
 */

export const EXPIRY_ITEM_KINDS = [
  "license",
  "permit",
  "insurance",
  "certification",
  "registration",
  "domain",
  "ssl",
  "other",
] as const;

export type ExpiryItemKind = (typeof EXPIRY_ITEM_KINDS)[number];

export const EXPIRY_ITEM_STATUSES = [
  "active",
  "expiring",
  "expired",
  "renewed",
  "archived",
] as const;

export type ExpiryItemStatus = (typeof EXPIRY_ITEM_STATUSES)[number];

export const EXPIRY_REMINDER_TIERS = ["holder", "manager", "owner"] as const;

export type ExpiryReminderTier = (typeof EXPIRY_REMINDER_TIERS)[number];

export const EXPIRY_REMINDER_STATUSES = [
  "pending",
  "sent",
  "skipped",
  "failed",
] as const;

export type ExpiryReminderStatus = (typeof EXPIRY_REMINDER_STATUSES)[number];

/**
 * The escalation ladder, in the order it is walked. Materialised once per item
 * at write time — the sweep never re-derives who to chase, it only asks whether
 * a row is still pending.
 */
export const EXPIRY_REMINDER_LADDER: readonly {
  offsetDays: number;
  tier: ExpiryReminderTier;
}[] = [
  { offsetDays: 90, tier: "holder" },
  { offsetDays: 60, tier: "holder" },
  { offsetDays: 30, tier: "manager" },
  { offsetDays: 7, tier: "owner" },
  { offsetDays: 0, tier: "owner" },
];

/**
 * Domain event types this context appends to the canonical event log. They
 * reach customers as signed outbound webhooks with no extra work — the
 * webhooks cron fans out whatever lands in the log — so this list is the
 * contract subscribers read.
 */
export const EXPIRY_EVENT_TYPES = [
  "expiry.item.created",
  "expiry.item.updated",
  "expiry.item.renewed",
  "expiry.item.archived",
  "expiry.item.expiring",
  "expiry.item.expired",
  "expiry.reminder.sent",
  "expiry.document.attached",
] as const;

export type ExpiryEventType = (typeof EXPIRY_EVENT_TYPES)[number];

export interface PublicExpiryItem {
  id: string;
  orgId: string;
  projectId: string | null;
  name: string;
  kind: ExpiryItemKind;
  templateKey: string | null;
  issuer: string | null;
  identifier: string | null;
  holderName: string | null;
  holderEmail: string | null;
  managerEmail: string | null;
  status: ExpiryItemStatus;
  issuedOn: string | null;
  expiresOn: string;
  notes: string | null;
  /** Whole days from today to `expiresOn`; negative once it has lapsed. */
  daysRemaining: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface PublicExpiryReminder {
  id: string;
  orgId: string;
  itemId: string;
  offsetDays: number;
  tier: ExpiryReminderTier;
  scheduledFor: string;
  status: ExpiryReminderStatus;
  recipient: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface CreateExpiryItemRequest {
  name: string;
  expiresOn: string;
  kind?: ExpiryItemKind;
  projectId?: string | null;
  issuer?: string | null;
  identifier?: string | null;
  holderName?: string | null;
  holderEmail?: string | null;
  managerEmail?: string | null;
  issuedOn?: string | null;
  notes?: string | null;
  templateKey?: string | null;
}

export type UpdateExpiryItemRequest = Partial<CreateExpiryItemRequest>;

export interface RenewExpiryItemRequest {
  expiresOn: string;
  identifier?: string | null;
  notes?: string | null;
}

export interface CreateExpiryItemResponse {
  item: PublicExpiryItem;
}

export interface GetExpiryItemResponse {
  item: PublicExpiryItem;
}

export interface UpdateExpiryItemResponse {
  item: PublicExpiryItem;
}

export interface ArchiveExpiryItemResponse {
  item: PublicExpiryItem;
}

export interface RenewExpiryItemResponse {
  item: PublicExpiryItem;
}

export interface ListExpiryItemsResponse {
  items: PublicExpiryItem[];
}

export interface ListExpiryRemindersResponse {
  reminders: PublicExpiryReminder[];
}
