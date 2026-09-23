import type { PublicExpiryItem, PublicExpiryReminder } from "@saas/contracts/expiry";
import type { ExpiryItem, ExpiryReminder } from "@saas/db/expiry";
import { daysBetween } from "./ladder.js";
import {
  expiryItemPublicId,
  expiryReminderPublicId,
  orgPublicId,
  projectPublicId,
} from "./ids.js";

export function toPublicItem(item: ExpiryItem, today: string): PublicExpiryItem {
  return {
    id: expiryItemPublicId(item.id),
    orgId: orgPublicId(item.orgId),
    projectId: item.projectId ? projectPublicId(item.projectId) : null,
    name: item.name,
    kind: item.kind as PublicExpiryItem["kind"],
    templateKey: item.templateKey,
    issuer: item.issuer,
    identifier: item.identifier,
    holderName: item.holderName,
    holderEmail: item.holderEmail,
    managerEmail: item.managerEmail,
    status: item.status as PublicExpiryItem["status"],
    issuedOn: item.issuedOn,
    expiresOn: item.expiresOn,
    notes: item.notes,
    daysRemaining: daysBetween(today, item.expiresOn),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    archivedAt: item.archivedAt ? item.archivedAt.toISOString() : null,
  };
}

export function toPublicReminder(reminder: ExpiryReminder): PublicExpiryReminder {
  return {
    id: expiryReminderPublicId(reminder.id),
    orgId: orgPublicId(reminder.orgId),
    itemId: expiryItemPublicId(reminder.itemId),
    offsetDays: reminder.offsetDays,
    tier: reminder.tier as PublicExpiryReminder["tier"],
    scheduledFor: reminder.scheduledFor,
    status: reminder.status as PublicExpiryReminder["status"],
    recipient: reminder.recipient,
    sentAt: reminder.sentAt ? reminder.sentAt.toISOString() : null,
    createdAt: reminder.createdAt.toISOString(),
  };
}
