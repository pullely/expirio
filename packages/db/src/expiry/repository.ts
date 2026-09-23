import type { SqlExecutor } from "../d1/executor.js";
import type {
  CreateExpiryItemInput,
  CreateExpiryReminderInput,
  CreateExpiryDocumentInput,
  CreateExpiryFeedTokenInput,
  CreateExpiryRenewalLinkInput,
  CursorPosition,
  DueReminder,
  ExpiryDocument,
  ExpiryFeedEntry,
  ExpiryFeedToken,
  ExpiryRenewalLink,
  ExpiryItem,
  ExpiryReminder,
  ExpiryRepository,
  ExpiryResult,
  ListExpiryItemsFilter,
  PagedResult,
  PageQueryParams,
  ScorecardRow,
  UpdateExpiryItemInput,
} from "./types.js";
import { isUniqueViolation } from "../d1/errors.js";

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : (value as string);
}

function mapItem(row: Record<string, unknown>): ExpiryItem {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: str(row.project_id),
    name: row.name as string,
    kind: row.kind as string,
    templateKey: str(row.template_key),
    issuer: str(row.issuer),
    identifier: str(row.identifier),
    holderName: str(row.holder_name),
    holderEmail: str(row.holder_email),
    managerEmail: str(row.manager_email),
    status: row.status as string,
    issuedOn: str(row.issued_on),
    expiresOn: row.expires_on as string,
    notes: str(row.notes),
    createdBy: str(row.created_by),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    archivedAt: row.archived_at ? new Date(row.archived_at as string) : null,
  };
}

function mapReminder(row: Record<string, unknown>): ExpiryReminder {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    itemId: row.item_id as string,
    offsetDays: Number(row.offset_days),
    tier: row.tier as string,
    scheduledFor: row.scheduled_for as string,
    status: row.status as string,
    recipient: str(row.recipient),
    notificationId: str(row.notification_id),
    sentAt: row.sent_at ? new Date(row.sent_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapDocument(row: Record<string, unknown>): ExpiryDocument {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    itemId: row.item_id as string,
    r2Key: row.r2_key as string,
    filename: row.filename as string,
    contentType: row.content_type as string,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256 as string,
    source: row.source as string,
    uploadedBy: str(row.uploaded_by),
    uploadedAt: new Date(row.uploaded_at as string),
  };
}

function mapLink(row: Record<string, unknown>): ExpiryRenewalLink {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    itemId: row.item_id as string,
    createdBy: str(row.created_by),
    expiresAt: new Date(row.expires_at as string),
    consumedAt: row.consumed_at ? new Date(row.consumed_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}

function mapFeedToken(row: Record<string, unknown>): ExpiryFeedToken {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: str(row.project_id),
    label: row.label as string,
    createdBy: str(row.created_by),
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string) : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}

// Token hashes never leave the repository: the mapped shapes above omit them.
const LINK_COLUMNS = "id, org_id, item_id, created_by, expires_at, consumed_at, created_at";
const FEED_COLUMNS = "id, org_id, project_id, label, created_by, revoked_at, last_used_at, created_at";

function safeError(message: string): ExpiryResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}

const ITEM_COLUMNS = `id, org_id, project_id, name, kind, template_key, issuer, identifier,
  holder_name, holder_email, manager_email, status, issued_on, expires_on, notes,
  created_by, created_at, updated_at, archived_at`;

export function createExpiryRepository(executor: SqlExecutor): ExpiryRepository {
  return {
    async createItem(input: CreateExpiryItemInput): Promise<ExpiryResult<ExpiryItem>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO expiry_items
             (id, org_id, project_id, name, kind, template_key, issuer, identifier,
              holder_name, holder_email, manager_email, status, issued_on, expires_on,
              notes, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12, $13, $14, $15, $16, $16)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.projectId,
            input.name,
            input.kind,
            input.templateKey,
            input.issuer,
            input.identifier,
            input.holderName,
            input.holderEmail,
            input.managerEmail,
            input.issuedOn,
            input.expiresOn,
            input.notes,
            input.createdBy,
            input.createdAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "expiry_item" } };
        }
        return { ok: true, value: mapItem(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "expiry_item" } };
        }
        return safeError("Failed to create expiry item");
      }
    },

    async getItemById(orgId: string, itemId: string): Promise<ExpiryResult<ExpiryItem>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT ${ITEM_COLUMNS} FROM expiry_items WHERE org_id = $1 AND id = $2`,
          [orgId, itemId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapItem(result.rows[0]!) };
      } catch {
        return safeError("Failed to read expiry item");
      }
    },

    async listItemsPaged(
      orgId: string,
      filter: ListExpiryItemsFilter,
      params: PageQueryParams,
    ): Promise<ExpiryResult<PagedResult<ExpiryItem>>> {
      try {
        // The executor translates Postgres-style `$n` only; a bare `?` would
        // arrive unbound. So the placeholder number is minted alongside the value.
        const values: unknown[] = [];
        const bind = (value: unknown): string => {
          values.push(value);
          return `$${values.length}`;
        };

        const where: string[] = [`org_id = ${bind(orgId)}`];

        if (filter.status) {
          where.push(`status = ${bind(filter.status)}`);
        } else {
          where.push("status <> 'archived'");
        }
        if (filter.projectId !== undefined) {
          if (filter.projectId === null) {
            where.push("project_id IS NULL");
          } else {
            where.push(`project_id = ${bind(filter.projectId)}`);
          }
        }
        if (filter.kind) {
          where.push(`kind = ${bind(filter.kind)}`);
        }
        if (filter.expiresBefore) {
          where.push(`expires_on <= ${bind(filter.expiresBefore)}`);
        }
        if (filter.expiresAfter) {
          where.push(`expires_on >= ${bind(filter.expiresAfter)}`);
        }
        if (params.cursor) {
          where.push(
            `(created_at, id) < (${bind(params.cursor.createdAt)}, ${bind(params.cursor.id)})`,
          );
        }
        const limitPlaceholder = bind(params.limit + 1);

        const result = await executor.execute<Record<string, unknown>>(
          `SELECT ${ITEM_COLUMNS} FROM expiry_items
           WHERE ${where.join(" AND ")}
           ORDER BY created_at DESC, id DESC
           LIMIT ${limitPlaceholder}`,
          values,
        );
        const rows = result.rows.map(mapItem);
        let nextCursor: CursorPosition | null = null;
        if (rows.length > params.limit) {
          rows.pop();
          const last = rows[rows.length - 1]!;
          nextCursor = { createdAt: last.createdAt.toISOString(), id: last.id };
        }
        return { ok: true, value: { items: rows, nextCursor } };
      } catch {
        return safeError("Failed to list expiry items");
      }
    },

    async updateItem(
      orgId: string,
      itemId: string,
      input: UpdateExpiryItemInput,
    ): Promise<ExpiryResult<ExpiryItem>> {
      const values: unknown[] = [];
      const bind = (value: unknown): string => {
        values.push(value);
        return `$${values.length}`;
      };
      const sets: string[] = [];
      const assign = (column: string, value: unknown) => {
        sets.push(`${column} = ${bind(value)}`);
      };

      if (input.name !== undefined) assign("name", input.name);
      if (input.kind !== undefined) assign("kind", input.kind);
      if (input.projectId !== undefined) assign("project_id", input.projectId);
      if (input.issuer !== undefined) assign("issuer", input.issuer);
      if (input.identifier !== undefined) assign("identifier", input.identifier);
      if (input.holderName !== undefined) assign("holder_name", input.holderName);
      if (input.holderEmail !== undefined) assign("holder_email", input.holderEmail);
      if (input.managerEmail !== undefined) assign("manager_email", input.managerEmail);
      if (input.issuedOn !== undefined) assign("issued_on", input.issuedOn);
      if (input.expiresOn !== undefined) assign("expires_on", input.expiresOn);
      if (input.notes !== undefined) assign("notes", input.notes);
      if (input.status !== undefined) assign("status", input.status);
      assign("updated_at", input.updatedAt.toISOString());

      try {
        const orgPlaceholder = bind(orgId);
        const itemPlaceholder = bind(itemId);
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE expiry_items SET ${sets.join(", ")}
           WHERE org_id = ${orgPlaceholder} AND id = ${itemPlaceholder} AND status <> 'archived'
           RETURNING *`,
          values,
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapItem(result.rows[0]!) };
      } catch {
        return safeError("Failed to update expiry item");
      }
    },

    async archiveItem(orgId: string, itemId: string, archivedAt: Date): Promise<ExpiryResult<ExpiryItem>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE expiry_items
           SET status = 'archived', archived_at = $3, updated_at = $3
           WHERE org_id = $1 AND id = $2 AND status <> 'archived'
           RETURNING *`,
          [orgId, itemId, archivedAt.toISOString()],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapItem(result.rows[0]!) };
      } catch {
        return safeError("Failed to archive expiry item");
      }
    },

    async countActiveItems(orgId: string): Promise<ExpiryResult<number>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT COUNT(*) AS count FROM expiry_items WHERE org_id = $1 AND status <> 'archived'`,
          [orgId],
        );
        const row = result.rows[0];
        if (!row) return { ok: true, value: 0 };
        return { ok: true, value: Number(row.count ?? 0) };
      } catch {
        return safeError("Failed to count expiry items");
      }
    },

    async createReminders(inputs: CreateExpiryReminderInput[]): Promise<ExpiryResult<number>> {
      if (inputs.length === 0) return { ok: true, value: 0 };
      try {
        let written = 0;
        for (const input of inputs) {
          const result = await executor.execute<Record<string, unknown>>(
            `INSERT INTO expiry_reminders
               (id, org_id, item_id, offset_days, tier, scheduled_for, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $7)
             ON CONFLICT (item_id, offset_days) DO NOTHING
             RETURNING id`,
            [
              input.id,
              input.orgId,
              input.itemId,
              input.offsetDays,
              input.tier,
              input.scheduledFor,
              input.createdAt.toISOString(),
            ],
          );
          written += result.rowCount ?? 0;
        }
        return { ok: true, value: written };
      } catch {
        return safeError("Failed to schedule reminders");
      }
    },

    async listRemindersForItem(orgId: string, itemId: string): Promise<ExpiryResult<ExpiryReminder[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM expiry_reminders
           WHERE org_id = $1 AND item_id = $2
           ORDER BY offset_days DESC`,
          [orgId, itemId],
        );
        return { ok: true, value: result.rows.map(mapReminder) };
      } catch {
        return safeError("Failed to list reminders");
      }
    },

    async deletePendingReminders(orgId: string, itemId: string): Promise<ExpiryResult<number>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `DELETE FROM expiry_reminders
           WHERE org_id = $1 AND item_id = $2 AND status = 'pending'
           RETURNING id`,
          [orgId, itemId],
        );
        return { ok: true, value: result.rowCount ?? 0 };
      } catch {
        return safeError("Failed to clear reminders");
      }
    },

    async skipPendingReminders(orgId: string, itemId: string, at: Date): Promise<ExpiryResult<number>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE expiry_reminders
           SET status = 'skipped', updated_at = $3
           WHERE org_id = $1 AND item_id = $2 AND status = 'pending'
           RETURNING id`,
          [orgId, itemId, at.toISOString()],
        );
        return { ok: true, value: result.rowCount ?? 0 };
      } catch {
        return safeError("Failed to skip reminders");
      }
    },

    async listDueReminders(today: string, limit: number): Promise<ExpiryResult<DueReminder[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT r.*, i.name AS item_name, i.kind AS item_kind, i.status AS item_status,
                  i.expires_on AS item_expires_on, i.project_id AS item_project_id,
                  i.holder_email AS holder_email, i.manager_email AS manager_email
           FROM expiry_reminders r
           JOIN expiry_items i ON i.id = r.item_id
           WHERE r.status = 'pending' AND r.scheduled_for <= $1
           ORDER BY r.scheduled_for ASC, r.id ASC
           LIMIT $2`,
          [today, limit],
        );
        const rows = result.rows.map((row) => ({
          ...mapReminder(row),
          itemName: row.item_name as string,
          itemKind: row.item_kind as string,
          itemStatus: row.item_status as string,
          itemExpiresOn: row.item_expires_on as string,
          itemProjectId: str(row.item_project_id),
          holderEmail: str(row.holder_email),
          managerEmail: str(row.manager_email),
        }));
        return { ok: true, value: rows };
      } catch {
        return safeError("Failed to read the due reminders");
      }
    },

    async markReminderSent(
      id: string,
      recipient: string,
      notificationId: string | null,
      sentAt: Date,
    ): Promise<ExpiryResult<boolean>> {
      try {
        // The `status = 'pending'` predicate is the idempotency: a second sweep
        // that raced the first updates nothing and reports false.
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE expiry_reminders
           SET status = 'sent', recipient = $2, notification_id = $3, sent_at = $4, updated_at = $4
           WHERE id = $1 AND status = 'pending'
           RETURNING id`,
          [id, recipient, notificationId, sentAt.toISOString()],
        );
        return { ok: true, value: (result.rowCount ?? 0) > 0 };
      } catch {
        return safeError("Failed to mark the reminder sent");
      }
    },

    async markReminderSkipped(id: string, at: Date): Promise<ExpiryResult<boolean>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE expiry_reminders
           SET status = 'skipped', updated_at = $2
           WHERE id = $1 AND status = 'pending'
           RETURNING id`,
          [id, at.toISOString()],
        );
        return { ok: true, value: (result.rowCount ?? 0) > 0 };
      } catch {
        return safeError("Failed to skip the reminder");
      }
    },

    async markReminderFailed(id: string, at: Date): Promise<ExpiryResult<boolean>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE expiry_reminders
           SET status = 'failed', updated_at = $2
           WHERE id = $1 AND status = 'pending'
           RETURNING id`,
          [id, at.toISOString()],
        );
        return { ok: true, value: (result.rowCount ?? 0) > 0 };
      } catch {
        return safeError("Failed to fail the reminder");
      }
    },

    async listOwnerEmails(orgId: string): Promise<ExpiryResult<string[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT u.email_lower AS email
           FROM membership_role_assignments ra
           JOIN membership_organization_members m
             ON m.org_id = ra.org_id AND m.subject_id = ra.subject_id AND m.status = 'active'
           JOIN identity_users u ON u.id = ra.subject_id AND u.status = 'active'
           WHERE ra.org_id = $1 AND ra.role = 'owner' AND ra.scope_kind = 'organization'
             AND ra.revoked_at IS NULL
           ORDER BY ra.created_at ASC, ra.id ASC
           LIMIT 5`,
          [orgId],
        );
        const emails = result.rows
          .map((row) => str(row.email))
          .filter((e): e is string => typeof e === "string" && e.length > 0);
        return { ok: true, value: [...new Set(emails)] };
      } catch {
        return safeError("Failed to read the organization owners");
      }
    },

    async listOverdueItems(today: string, limit: number): Promise<ExpiryResult<ExpiryItem[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT ${ITEM_COLUMNS} FROM expiry_items
           WHERE status IN ('active', 'expiring') AND expires_on < $1
           ORDER BY expires_on ASC
           LIMIT $2`,
          [today, limit],
        );
        return { ok: true, value: result.rows.map(mapItem) };
      } catch {
        return safeError("Failed to read the overdue items");
      }
    },

    async setItemStatus(
      orgId: string,
      itemId: string,
      status: string,
      at: Date,
    ): Promise<ExpiryResult<boolean>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE expiry_items SET status = $3, updated_at = $4
           WHERE org_id = $1 AND id = $2 AND status <> $3
           RETURNING id`,
          [orgId, itemId, status, at.toISOString()],
        );
        return { ok: true, value: (result.rowCount ?? 0) > 0 };
      } catch {
        return safeError("Failed to set the item status");
      }
    },

    async scorecard(orgId: string, today: string, horizon: string): Promise<ExpiryResult<ScorecardRow[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT project_id,
                  COUNT(*) AS total,
                  SUM(CASE WHEN status = 'active'   THEN 1 ELSE 0 END) AS active,
                  SUM(CASE WHEN status = 'expiring' THEN 1 ELSE 0 END) AS expiring,
                  SUM(CASE WHEN status = 'expired'  THEN 1 ELSE 0 END) AS expired,
                  SUM(CASE WHEN status = 'renewed'  THEN 1 ELSE 0 END) AS renewed,
                  SUM(CASE WHEN status <> 'archived' AND expires_on >= $2 AND expires_on <= $3
                           THEN 1 ELSE 0 END) AS due_within_30
           FROM expiry_items
           WHERE org_id = $1 AND status <> 'archived'
           GROUP BY project_id
           ORDER BY project_id IS NULL DESC, project_id ASC`,
          [orgId, today, horizon],
        );
        const rows = result.rows.map((row) => ({
          projectId: str(row.project_id),
          total: Number(row.total ?? 0),
          active: Number(row.active ?? 0),
          expiring: Number(row.expiring ?? 0),
          expired: Number(row.expired ?? 0),
          renewed: Number(row.renewed ?? 0),
          dueWithin30: Number(row.due_within_30 ?? 0),
        }));
        return { ok: true, value: rows };
      } catch {
        return safeError("Failed to build the scorecard");
      }
    },

    async createDocument(input: CreateExpiryDocumentInput): Promise<ExpiryResult<ExpiryDocument>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO expiry_documents
             (id, org_id, item_id, r2_key, filename, content_type, size_bytes, sha256, source, uploaded_by, uploaded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.itemId,
            input.r2Key,
            input.filename,
            input.contentType,
            input.sizeBytes,
            input.sha256,
            input.source,
            input.uploadedBy,
            input.uploadedAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) return safeError("Failed to record the document");
        return { ok: true, value: mapDocument(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) return { ok: false, error: { kind: "conflict", entity: "expiry_document" } };
        return safeError("Failed to record the document");
      }
    },

    async listDocuments(orgId: string, itemId: string): Promise<ExpiryResult<ExpiryDocument[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM expiry_documents WHERE org_id = $1 AND item_id = $2
           ORDER BY uploaded_at DESC, id DESC`,
          [orgId, itemId],
        );
        return { ok: true, value: result.rows.map(mapDocument) };
      } catch {
        return safeError("Failed to list documents");
      }
    },

    async getDocument(orgId: string, documentId: string): Promise<ExpiryResult<ExpiryDocument>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM expiry_documents WHERE org_id = $1 AND id = $2`,
          [orgId, documentId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapDocument(result.rows[0]!) };
      } catch {
        return safeError("Failed to read the document");
      }
    },

    async createRenewalLink(input: CreateExpiryRenewalLinkInput): Promise<ExpiryResult<ExpiryRenewalLink>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO expiry_renewal_links (id, org_id, item_id, token_hash, created_by, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING ${LINK_COLUMNS}`,
          [
            input.id,
            input.orgId,
            input.itemId,
            input.tokenHash,
            input.createdBy,
            input.expiresAt.toISOString(),
            input.createdAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) return safeError("Failed to mint the renewal link");
        return { ok: true, value: mapLink(result.rows[0]!) };
      } catch {
        return safeError("Failed to mint the renewal link");
      }
    },

    async findRenewalLinkByHash(tokenHash: string, at: Date): Promise<ExpiryResult<ExpiryRenewalLink>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT ${LINK_COLUMNS} FROM expiry_renewal_links
           WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2`,
          [tokenHash, at.toISOString()],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapLink(result.rows[0]!) };
      } catch {
        return safeError("Failed to read the renewal link");
      }
    },

    async consumeRenewalLink(id: string, at: Date): Promise<ExpiryResult<boolean>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE expiry_renewal_links SET consumed_at = $2
           WHERE id = $1 AND consumed_at IS NULL AND expires_at > $2
           RETURNING id`,
          [id, at.toISOString()],
        );
        return { ok: true, value: (result.rowCount ?? 0) > 0 };
      } catch {
        return safeError("Failed to consume the renewal link");
      }
    },

    async createFeedToken(input: CreateExpiryFeedTokenInput): Promise<ExpiryResult<ExpiryFeedToken>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO expiry_feed_tokens (id, org_id, project_id, label, token_hash, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING ${FEED_COLUMNS}`,
          [
            input.id,
            input.orgId,
            input.projectId,
            input.label,
            input.tokenHash,
            input.createdBy,
            input.createdAt.toISOString(),
          ],
        );
        if (result.rowCount === 0) return safeError("Failed to mint the feed token");
        return { ok: true, value: mapFeedToken(result.rows[0]!) };
      } catch {
        return safeError("Failed to mint the feed token");
      }
    },

    async listFeedTokens(orgId: string): Promise<ExpiryResult<ExpiryFeedToken[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT ${FEED_COLUMNS} FROM expiry_feed_tokens WHERE org_id = $1
           ORDER BY created_at DESC, id DESC`,
          [orgId],
        );
        return { ok: true, value: result.rows.map(mapFeedToken) };
      } catch {
        return safeError("Failed to list feed tokens");
      }
    },

    async revokeFeedToken(orgId: string, id: string, at: Date): Promise<ExpiryResult<boolean>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE expiry_feed_tokens SET revoked_at = $3
           WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL
           RETURNING id`,
          [orgId, id, at.toISOString()],
        );
        return { ok: true, value: (result.rowCount ?? 0) > 0 };
      } catch {
        return safeError("Failed to revoke the feed token");
      }
    },

    async findFeedTokenByHash(tokenHash: string): Promise<ExpiryResult<ExpiryFeedToken>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT ${FEED_COLUMNS} FROM expiry_feed_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
          [tokenHash],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapFeedToken(result.rows[0]!) };
      } catch {
        return safeError("Failed to read the feed token");
      }
    },

    async touchFeedToken(id: string, at: Date): Promise<ExpiryResult<boolean>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE expiry_feed_tokens SET last_used_at = $2 WHERE id = $1 RETURNING id`,
          [id, at.toISOString()],
        );
        return { ok: true, value: (result.rowCount ?? 0) > 0 };
      } catch {
        return safeError("Failed to touch the feed token");
      }
    },

    async listFeedEntries(
      orgId: string,
      projectId: string | null,
      from: string,
      limit: number,
    ): Promise<ExpiryResult<ExpiryFeedEntry[]>> {
      try {
        const scoped = projectId !== null;
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT id, name, kind, expires_on, updated_at FROM expiry_items
           WHERE org_id = $1 AND status <> 'archived' AND expires_on >= $2
             ${scoped ? "AND project_id = $4" : ""}
           ORDER BY expires_on ASC, id ASC
           LIMIT $3`,
          scoped ? [orgId, from, limit, projectId] : [orgId, from, limit],
        );
        return {
          ok: true,
          value: result.rows.map((row) => ({
            id: row.id as string,
            name: row.name as string,
            kind: row.kind as string,
            expiresOn: row.expires_on as string,
            updatedAt: new Date(row.updated_at as string),
          })),
        };
      } catch {
        return safeError("Failed to read the feed");
      }
    },

  };
}
