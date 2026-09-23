import { buildScorecard } from "@expiry-worker/handlers/scorecard";

describe("buildScorecard", () => {
  it("renders public location ids, totals every column and computes compliance", () => {
    const card = buildScorecard(
      [
        { projectId: null, total: 4, active: 2, expiring: 1, expired: 1, renewed: 0, dueWithin30: 1 },
        {
          projectId: "44444444-4444-4444-8444-444444444444",
          total: 6,
          active: 6,
          expiring: 0,
          expired: 0,
          renewed: 0,
          dueWithin30: 0,
        },
      ],
      "2026-10-01",
    );
    expect(card.asOf).toBe("2026-10-01");
    expect(card.horizonDays).toBe(30);
    expect(card.locations[0]!.projectId).toBeNull();
    expect(card.locations[1]!.projectId).toBe("prj_44444444444444448444444444444444");
    expect(card.locations[0]!.compliantPercent).toBe(75);
    expect(card.locations[1]!.compliantPercent).toBe(100);
    expect(card.totals).toEqual({
      total: 10,
      active: 8,
      expiring: 1,
      expired: 1,
      renewed: 0,
      dueWithin30: 1,
      compliantPercent: 90,
    });
  });

  it("calls an empty register fully compliant", () => {
    expect(buildScorecard([], "2026-10-01").totals.compliantPercent).toBe(100);
  });
});
