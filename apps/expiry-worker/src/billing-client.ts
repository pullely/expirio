import type { CheckBillingEntitlementResponse } from "@saas/contracts/billing";

/**
 * Internal caller identity presented to billing-worker on its
 * service-binding-only entitlement seam. Non-secret provenance: only Workers
 * bound to billing-worker over a service binding can present it.
 */
export const INTERNAL_CALLER = "expiry-worker";

const INTERNAL_CALLER_HEADER = "x-internal-caller";

export type BillingEntitlementResult =
  | { kind: "decision"; decision: CheckBillingEntitlementResponse }
  | { kind: "service_error" };

export async function checkBillingEntitlement(
  billingWorker: Fetcher,
  orgPublicId: string,
  entitlementKey: string,
  requestId: string,
): Promise<BillingEntitlementResult> {
  let response: Response;
  try {
    response = await billingWorker.fetch(
      "http://billing-worker/v1/internal/billing/entitlements/check",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
          [INTERNAL_CALLER_HEADER]: INTERNAL_CALLER,
        },
        body: JSON.stringify({ orgId: orgPublicId, entitlementKey }),
      },
    );
  } catch {
    return { kind: "service_error" };
  }

  if (!response.ok) return { kind: "service_error" };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { kind: "service_error" };
  }

  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) {
    return { kind: "service_error" };
  }
  const data = (parsed as { data: unknown }).data;
  if (!data || typeof data !== "object") return { kind: "service_error" };

  const obj = data as Record<string, unknown>;
  if (typeof obj.allowed !== "boolean") return { kind: "service_error" };
  if (typeof obj.orgId !== "string" || typeof obj.entitlementKey !== "string") {
    return { kind: "service_error" };
  }

  return { kind: "decision", decision: data as CheckBillingEntitlementResponse };
}

export type EntitlementGate =
  | { kind: "allow" }
  | { kind: "deny"; reason: string; message: string };

/**
 * `limit.expiry_items` as a quantity gate, with the same semantics
 * projects-worker applies to `limit.projects`.
 *
 * One deliberate difference: an entitlement the org's plan does not declare at
 * all is ALLOWED here rather than denied. The baseline's seeded plans do not
 * carry an expiry limit, and a fresh organization that cannot record its first
 * licence because billing has no opinion about licences is a worse failure
 * than an unmetered one.
 */
export function decideItemsLimit(
  decision: CheckBillingEntitlementResponse,
  activeCount: number,
): EntitlementGate {
  if (!decision.allowed) {
    if (decision.reason === "not_configured") return { kind: "allow" };
    return {
      kind: "deny",
      reason: decision.reason,
      message: "Tracking new items is disabled by your current plan",
    };
  }
  if (decision.valueType !== "quantity") return { kind: "allow" };
  if (decision.limitValue === null) return { kind: "allow" };
  if (
    typeof decision.limitValue !== "number" ||
    !Number.isFinite(decision.limitValue) ||
    decision.limitValue < 0
  ) {
    return { kind: "allow" };
  }
  if (activeCount < decision.limitValue) return { kind: "allow" };
  return {
    kind: "deny",
    reason: "limit_reached",
    message: "Your plan's tracked-item limit has been reached",
  };
}
