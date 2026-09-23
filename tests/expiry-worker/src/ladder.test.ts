import {
  daysBetween,
  isIsoDate,
  ladderFor,
  ladderRows,
  shiftDate,
  toIsoDate,
} from "@expiry-worker/ladder";
import type { Uuid } from "@saas/db/ids";

const ORG = "11111111-1111-4111-8111-111111111111" as Uuid;
const ITEM = "22222222-2222-4222-8222-222222222222";

describe("date helpers", () => {
  it("accepts real calendar dates and rejects impostors", () => {
    expect(isIsoDate("2026-09-23")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false); // 2026 is not a leap year
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-9-3")).toBe(false);
    expect(isIsoDate("tomorrow")).toBe(false);
    expect(isIsoDate("")).toBe(false);
  });

  it("shifts and measures in whole days", () => {
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-09-23", "2026-12-22")).toBe(90);
    expect(daysBetween("2026-09-23", "2026-09-16")).toBe(-7);
  });

  it("takes the UTC calendar date of an instant", () => {
    expect(toIsoDate(new Date("2026-09-23T23:59:59.999Z"))).toBe("2026-09-23");
  });
});

describe("the escalation ladder", () => {
  it("cuts all five rungs for an item far from its date", () => {
    const rungs = ladderFor("2027-01-01", "2026-01-01");
    expect(rungs.map((r) => r.offsetDays)).toEqual([90, 60, 30, 7, 0]);
    expect(rungs.map((r) => r.tier)).toEqual([
      "holder",
      "holder",
      "manager",
      "owner",
      "owner",
    ]);
  });

  it("schedules each rung exactly offsetDays before the expiry", () => {
    const rungs = ladderFor("2026-12-22", "2026-01-01");
    const ninety = rungs.find((r) => r.offsetDays === 90)!;
    expect(ninety.scheduledFor).toBe("2026-09-23");
    expect(daysBetween(ninety.scheduledFor, "2026-12-22")).toBe(90);
  });

  it("does not back-date: an item added inside its window starts at the rung it is in", () => {
    // 45 days out — the 90 and 60 day rungs are already behind us.
    const rungs = ladderFor("2026-11-07", "2026-09-23");
    expect(rungs.map((r) => r.offsetDays)).toEqual([30, 7, 0]);
  });

  it("cuts nothing for an item that has already lapsed", () => {
    expect(ladderFor("2026-09-01", "2026-09-23")).toEqual([]);
  });

  it("still cuts the final rung on the expiry day itself", () => {
    const rungs = ladderFor("2026-09-23", "2026-09-23");
    expect(rungs.map((r) => r.offsetDays)).toEqual([0]);
    expect(rungs[0]!.tier).toBe("owner");
  });

  it("renders repository rows carrying the org, the item and fresh ids", () => {
    let n = 0;
    const rows = ladderRows(
      ORG,
      ITEM,
      "2027-01-01",
      "2026-01-01",
      new Date("2026-01-01T00:00:00.000Z"),
      () => `id-${++n}`,
    );
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.id)).size).toBe(5);
    for (const row of rows) {
      expect(row.orgId).toBe(ORG);
      expect(row.itemId).toBe(ITEM);
    }
    // One rung per offset — the shape the UNIQUE index enforces in the schema.
    expect(new Set(rows.map((r) => r.offsetDays)).size).toBe(5);
  });
});
