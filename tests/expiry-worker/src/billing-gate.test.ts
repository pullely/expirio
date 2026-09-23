import { decideItemsLimit } from "@expiry-worker/billing-client";
import type { CheckBillingEntitlementResponse } from "@saas/contracts/billing";

function decision(
  over: Partial<CheckBillingEntitlementResponse>,
): CheckBillingEntitlementResponse {
  return {
    orgId: "org_1",
    entitlementKey: "limit.expiry_items",
    allowed: true,
    reason: "allowed",
    valueType: "quantity",
    limitValue: null,
    ...over,
  } as CheckBillingEntitlementResponse;
}

describe("decideItemsLimit", () => {
  it("allows below the limit and denies at it", () => {
    expect(decideItemsLimit(decision({ limitValue: 50 }), 49).kind).toBe("allow");
    const denied = decideItemsLimit(decision({ limitValue: 50 }), 50);
    expect(denied.kind).toBe("deny");
    if (denied.kind === "deny") expect(denied.reason).toBe("limit_reached");
  });

  it("treats a null limit as unlimited", () => {
    expect(decideItemsLimit(decision({ limitValue: null }), 10_000).kind).toBe("allow");
  });

  it("allows when the plan declares no opinion about expiry items", () => {
    // The deliberate departure from projects-worker's gate: refusing to record
    // a licence because billing has no entitlement row is the wrong trade.
    const gate = decideItemsLimit(
      decision({ allowed: false, reason: "not_configured" }),
      10,
    );
    expect(gate.kind).toBe("allow");
  });

  it("denies when the plan explicitly disables it", () => {
    const gate = decideItemsLimit(decision({ allowed: false, reason: "disabled" }), 0);
    expect(gate.kind).toBe("deny");
    if (gate.kind === "deny") expect(gate.reason).toBe("disabled");
  });

  it("allows rather than fails closed on a malformed limit", () => {
    expect(decideItemsLimit(decision({ valueType: "boolean" }), 5).kind).toBe("allow");
    expect(
      decideItemsLimit(decision({ limitValue: Number.NaN as unknown as number }), 5).kind,
    ).toBe("allow");
  });
});
