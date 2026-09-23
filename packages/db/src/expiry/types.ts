export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../d1/executor.js";
import type { Uuid } from "../ids/index.js";

export type ExpiryRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "internal"; message: string };

export type ExpiryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ExpiryRepositoryError };

export interface ExpiryItem {
  id: string;
  orgId: string;
  projectId: string | null;
  name: string;
  kind: string;
  templateKey: string | null;
  issuer: string | null;
  identifier: string | null;
  holderName: string | null;
  holderEmail: string | null;
  managerEmail: string | null;
  status: string;
  issuedOn: string | null;
  expiresOn: string;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface ExpiryReminder {
  id: string;
  orgId: string;
  itemId: string;
  offsetDays: number;
  tier: string;
  scheduledFor: string;
  status: string;
  recipient: string | null;
  notificationId: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateExpiryItemInput {
  id: string;
  orgId: Uuid;
  projectId: string | null;
  name: string;
  kind: string;
  templateKey: string | null;
  issuer: string | null;
  identifier: string | null;
  holderName: string | null;
  holderEmail: string | null;
  managerEmail: string | null;
  issuedOn: string | null;
  expiresOn: string;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface UpdateExpiryItemInput {
  name?: string;
  kind?: string;
  projectId?: string | null;
  issuer?: string | null;
  identifier?: string | null;
  holderName?: string | null;
  holderEmail?: string | null;
  managerEmail?: string | null;
  issuedOn?: string | null;
  expiresOn?: string;
  notes?: string | null;
  status?: string;
  updatedAt: Date;
}

export interface CreateExpiryReminderInput {
  id: string;
  orgId: Uuid;
  itemId: string;
  offsetDays: number;
  tier: string;
  scheduledFor: string;
  createdAt: Date;
}

export interface DueReminder extends ExpiryReminder {
  itemName: string;
  itemKind: string;
  itemStatus: string;
  itemExpiresOn: string;
  itemProjectId: string | null;
  holderEmail: string | null;
  managerEmail: string | null;
}

export interface ScorecardRow {
  projectId: string | null;
  total: number;
  active: number;
  expiring: number;
  expired: number;
  renewed: number;
  dueWithin30: number;
}

export interface CursorPosition {
  createdAt: string;
  id: string;
}

export interface PageQueryParams {
  limit: number;
  cursor: CursorPosition | null;
}

export interface PagedResult<T> {
  items: T[];
  nextCursor: CursorPosition | null;
}

export interface ListExpiryItemsFilter {
  projectId?: string | null;
  kind?: string;
  status?: string;
  expiresBefore?: string;
  expiresAfter?: string;
}

export interface ExpiryRepository {
  createItem(input: CreateExpiryItemInput): Promise<ExpiryResult<ExpiryItem>>;
  getItemById(orgId: Uuid, itemId: string): Promise<ExpiryResult<ExpiryItem>>;
  listItemsPaged(
    orgId: Uuid,
    filter: ListExpiryItemsFilter,
    params: PageQueryParams,
  ): Promise<ExpiryResult<PagedResult<ExpiryItem>>>;
  updateItem(orgId: Uuid, itemId: string, input: UpdateExpiryItemInput): Promise<ExpiryResult<ExpiryItem>>;
  archiveItem(orgId: Uuid, itemId: string, archivedAt: Date): Promise<ExpiryResult<ExpiryItem>>;
  countActiveItems(orgId: Uuid): Promise<ExpiryResult<number>>;

  /** Write the ladder. Rows already present for (item_id, offset_days) are left alone. */
  createReminders(inputs: CreateExpiryReminderInput[]): Promise<ExpiryResult<number>>;
  listRemindersForItem(orgId: Uuid, itemId: string): Promise<ExpiryResult<ExpiryReminder[]>>;
  /** Drop the unsent rungs of an item's ladder — used when the expiry date moves. */
  deletePendingReminders(orgId: Uuid, itemId: string): Promise<ExpiryResult<number>>;
  /** Mark the unsent rungs skipped rather than deleting them (renew/archive). */
  skipPendingReminders(orgId: Uuid, itemId: string, at: Date): Promise<ExpiryResult<number>>;

  /** Bounded sweep input: pending rungs due on or before `today`, oldest first. */
  listDueReminders(today: string, limit: number): Promise<ExpiryResult<DueReminder[]>>;
  markReminderSent(
    id: string,
    recipient: string,
    notificationId: string | null,
    sentAt: Date,
  ): Promise<ExpiryResult<boolean>>;
  markReminderSkipped(id: string, at: Date): Promise<ExpiryResult<boolean>>;
  /** A rung with nobody to send to: `failed`, with the reason in `recipient` left null. */
  markReminderFailed(id: string, at: Date): Promise<ExpiryResult<boolean>>;
  /**
   * The org's active owners' email addresses, oldest assignment first — the
   * top tier of the ladder. A read-only join onto membership and identity rows
   * in the same D1 database; nothing is written across the context boundary.
   */
  listOwnerEmails(orgId: Uuid): Promise<ExpiryResult<string[]>>;

  /** Items past their date that are still `active`/`expiring`. */
  listOverdueItems(today: string, limit: number): Promise<ExpiryResult<ExpiryItem[]>>;
  setItemStatus(orgId: string, itemId: string, status: string, at: Date): Promise<ExpiryResult<boolean>>;

  scorecard(orgId: Uuid, today: string, horizon: string): Promise<ExpiryResult<ScorecardRow[]>>;
}
