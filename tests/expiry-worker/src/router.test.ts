import { route } from "@expiry-worker/router";
import type { Env } from "@expiry-worker/env";
import { expiryItemPublicId, orgPublicId } from "@expiry-worker/ids";

const ORG = orgPublicId("11111111-1111-4111-8111-111111111111");
const ITEM = expiryItemPublicId("22222222-2222-4222-8222-222222222222");

function env(over: Partial<Env> = {}): Env {
  return { ENVIRONMENT: "test", ...over } as Env;
}

function actorHeaders(): Record<string, string> {
  return {
    "x-actor-subject-id": "33333333-3333-4333-8333-333333333333",
    "x-actor-subject-type": "user",
  };
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function at(payload: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown> | undefined)?.[key],
      payload,
    );
}

describe("health", () => {
  it("reports which bindings are configured", async () => {
    const res = await route(new Request("https://expiry.internal/health"), env());
    expect(res.status).toBe(200);
    const payload = await body(res);
    expect(at(payload, "data.service")).toBe("expiry-worker");
    expect(at(payload, "data.checks.database.configured")).toBe(false);
  });
});

describe("routing", () => {
  it("404s an unknown path", async () => {
    const res = await route(new Request("https://expiry.internal/v1/nope"), env());
    expect(res.status).toBe(404);
  });

  it("401s when the edge did not set the actor headers", async () => {
    const res = await route(
      new Request(`https://expiry.internal/v1/organizations/${ORG}/expiry-items`),
      env({ PLATFORM_DB: {} as D1Database }),
    );
    expect(res.status).toBe(401);
    expect(at(await body(res), "error.code")).toBe("unauthenticated");
  });

  it("405s a method the collection does not serve", async () => {
    const res = await route(
      new Request(`https://expiry.internal/v1/organizations/${ORG}/expiry-items`, {
        method: "PUT",
        headers: actorHeaders(),
      }),
      env(),
    );
    expect(res.status).toBe(405);
  });

  it("404s an id that is not an expiry-item id, before any lookup", async () => {
    const res = await route(
      new Request(`https://expiry.internal/v1/organizations/${ORG}/expiry-items/prj_deadbeef`, {
        headers: actorHeaders(),
      }),
      env(),
    );
    expect(res.status).toBe(404);
  });

  it("404s an organization id that is not an org id", async () => {
    const res = await route(
      new Request("https://expiry.internal/v1/organizations/not-an-org/expiry-items", {
        headers: actorHeaders(),
      }),
      env(),
    );
    expect(res.status).toBe(404);
  });

  it("routes /renew ahead of the bare-id pattern it also matches", async () => {
    // POST on the bare id is 405; on /renew it is accepted and reaches the
    // handler, which answers 503 for the missing DB binding. That difference
    // is the proof the more specific pattern won.
    const bare = await route(
      new Request(`https://expiry.internal/v1/organizations/${ORG}/expiry-items/${ITEM}`, {
        method: "POST",
        headers: actorHeaders(),
      }),
      env(),
    );
    expect(bare.status).toBe(405);

    const renew = await route(
      new Request(`https://expiry.internal/v1/organizations/${ORG}/expiry-items/${ITEM}/renew`, {
        method: "POST",
        headers: { ...actorHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ expiresOn: "2027-01-01" }),
      }),
      env(),
    );
    expect(renew.status).toBe(503);
  });

  it("serves the reminder list only as GET", async () => {
    const res = await route(
      new Request(`https://expiry.internal/v1/organizations/${ORG}/expiry-items/${ITEM}/reminders`, {
        method: "DELETE",
        headers: actorHeaders(),
      }),
      env(),
    );
    expect(res.status).toBe(405);
  });
});
