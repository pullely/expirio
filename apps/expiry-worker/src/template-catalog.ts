import type {
  ExpiryTemplateVertical,
  PublicExpiryTemplate,
  PublicExpiryTemplateItem,
} from "@saas/contracts/expiry";

/**
 * The vertical template catalogue — static, in code, in the shape of the
 * baseline's `apps/billing-worker/src/plan-catalog.ts`. It ships with the
 * deploy, versions with the repo and costs no migration. The price is that an
 * operator cannot author a vertical of their own (risk EX-D).
 *
 * `validityMonths` is a DEFAULT, not a rule: renewal cycles differ by state
 * and issuer, so applying a template writes a best guess the operator then
 * corrects with the date printed on the real card.
 */
export const TEMPLATE_CATALOG: readonly PublicExpiryTemplate[] = [
  {
    key: "clinic",
    name: "Clinic",
    description: "Medical, dental and veterinary practices — per-clinician credentials.",
    items: [
      {
        key: "dea-registration",
        name: "DEA registration",
        kind: "registration",
        issuer: "U.S. Drug Enforcement Administration",
        validityMonths: 36,
      },
      {
        key: "cpr-bls",
        name: "CPR / BLS card",
        kind: "certification",
        issuer: "American Heart Association",
        validityMonths: 24,
      },
      {
        key: "state-licence",
        name: "State professional licence",
        kind: "license",
        issuer: "State licensing board",
        validityMonths: 24,
      },
      {
        key: "malpractice",
        name: "Malpractice insurance policy",
        kind: "insurance",
        issuer: null,
        validityMonths: 12,
      },
    ],
  },
  {
    key: "trades",
    name: "Trades",
    description: "HVAC, electrical, plumbing and general contractors — per-technician and per-company.",
    items: [
      {
        key: "epa-608",
        name: "EPA 608 certification",
        kind: "certification",
        issuer: "U.S. Environmental Protection Agency",
        // Section 608 technician cards do not lapse; the date tracked is the
        // employer's re-verification cycle, hence a long default.
        validityMonths: 60,
      },
      {
        key: "osha-10",
        name: "OSHA 10 card",
        kind: "certification",
        issuer: "OSHA Outreach Training Program",
        validityMonths: 60,
      },
      {
        key: "contractor-licence",
        name: "Contractor licence",
        kind: "license",
        issuer: "State contractor board",
        validityMonths: 24,
      },
      {
        key: "general-liability",
        name: "General liability insurance",
        kind: "insurance",
        issuer: null,
        validityMonths: 12,
      },
      {
        key: "vehicle-registration",
        name: "Vehicle registration",
        kind: "registration",
        issuer: "State DMV",
        validityMonths: 12,
      },
    ],
  },
  {
    key: "childcare",
    name: "Childcare",
    description: "Daycares and early-learning centres — the facility and its staff.",
    items: [
      {
        key: "state-childcare-licence",
        name: "State childcare licence",
        kind: "license",
        issuer: "State childcare licensing agency",
        validityMonths: 24,
      },
      {
        key: "cpr-first-aid",
        name: "Pediatric CPR / first aid",
        kind: "certification",
        issuer: "American Red Cross",
        validityMonths: 24,
      },
      {
        key: "background-check",
        name: "Background check clearance",
        kind: "certification",
        issuer: null,
        validityMonths: 60,
      },
      {
        key: "fire-inspection",
        name: "Fire inspection certificate",
        kind: "permit",
        issuer: "Local fire marshal",
        validityMonths: 12,
      },
    ],
  },
];

export function findTemplate(key: string): PublicExpiryTemplate | null {
  return TEMPLATE_CATALOG.find((t) => t.key === (key as ExpiryTemplateVertical)) ?? null;
}

/** The template's rows, narrowed to `itemKeys` when given; unknown keys are reported, not dropped. */
export function selectTemplateItems(
  template: PublicExpiryTemplate,
  itemKeys: readonly string[] | undefined,
): { items: PublicExpiryTemplateItem[]; unknown: string[] } {
  if (!itemKeys || itemKeys.length === 0) return { items: [...template.items], unknown: [] };
  const wanted = new Set(itemKeys);
  const items = template.items.filter((i) => wanted.has(i.key));
  const known = new Set(template.items.map((i) => i.key));
  const unknown = itemKeys.filter((k) => !known.has(k));
  return { items, unknown };
}

/** `date` plus whole calendar months, clamped to the month's last day (Jan 31 + 1 → Feb 28/29). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const targetMonthIndex = m - 1 + months;
  const year = y + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}
