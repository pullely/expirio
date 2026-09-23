import { EXPIRY_REMINDER_LADDER } from "@saas/contracts/expiry";
import type { CreateExpiryReminderInput } from "@saas/db/expiry";
import type { Uuid } from "@saas/db/ids";

const DAY_MS = 86_400_000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a calendar date this context is willing to store: `YYYY-MM-DD`, real. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString().slice(0, 10) === value;
}

/** The UTC calendar date of an instant, as `YYYY-MM-DD`. */
export function toIsoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `date` shifted by whole days, as `YYYY-MM-DD`. */
export function shiftDate(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative once `to` is in the past. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / DAY_MS);
}

export interface LadderRung {
  offsetDays: number;
  tier: string;
  scheduledFor: string;
}

/**
 * The rungs of the escalation ladder that are still in the future for an item
 * expiring on `expiresOn`, given that today is `today`.
 *
 * A rung whose date has already passed is NOT scheduled: back-dating a chase
 * would fire it on the next sweep and tell a holder their licence expired 80
 * days ago in a mail headed "90 days to go". An item added inside its own
 * warning window simply starts at the rung it is actually in.
 */
export function ladderFor(expiresOn: string, today: string): LadderRung[] {
  const rungs: LadderRung[] = [];
  for (const { offsetDays, tier } of EXPIRY_REMINDER_LADDER) {
    const scheduledFor = shiftDate(expiresOn, -offsetDays);
    if (daysBetween(today, scheduledFor) < 0) continue;
    rungs.push({ offsetDays, tier, scheduledFor });
  }
  return rungs;
}

/** The ladder as repository input, ids minted by the caller's generator. */
export function ladderRows(
  orgId: Uuid,
  itemId: string,
  expiresOn: string,
  today: string,
  now: Date,
  newId: () => string,
): CreateExpiryReminderInput[] {
  return ladderFor(expiresOn, today).map((rung) => ({
    id: newId(),
    orgId,
    itemId,
    offsetDays: rung.offsetDays,
    tier: rung.tier,
    scheduledFor: rung.scheduledFor,
    createdAt: now,
  }));
}
