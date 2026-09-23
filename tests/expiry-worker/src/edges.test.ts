import type { ExpiryItem, ExpiryRenewalLink, ExpiryRepository } from "@saas/db/expiry";
import type { EventsRepository } from "@saas/db/events";
import type { Env } from "@expiry-worker/env";
import { escapeIcsText, foldIcsLine, renderIcs } from "@expiry-worker/ics";
import { checkDocument, documentKey, safeFilename } from "@expiry-worker/documents";
import { isWellFormedToken, mintToken, sha256Hex } from "@expiry-worker/tokens";
import { routePublicIngress } from "@expiry-worker/handlers/public-ingress";
import { route } from "@expiry-worker/router";

const ORG = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-01T12:00:00.000Z");

describe("ICS rendering", () => {
  it("renders one all-day VEVENT per entry with CRLF line endings", () => {
    const ics = renderIcs(
      "Expirio — Front desk",
      [{ id: ITEM, name: "DEA registration", kind: "registration", expiresOn: "2026-12-31", updatedAt: NOW }],
      NOW,
    );
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261231\r\n");
    expect(ics).toContain("DTEND;VALUE=DATE:20270101\r\n");
    expect(ics).toContain("SUMMARY:Expires: DEA registration\r\n");
    expect(ics).toContain("UID:exi_22222222222242228222222222222222-20261231@expirio");
    expect(ics.split("BEGIN:VEVENT")).toHaveLength(2);
  });

  it("escapes text and folds long lines at 75 octets", () => {
    expect(escapeIcsText("a;b,c\\d\ne")).toBe("a\;b\\,c\\\\d\\ne");
    const folded = foldIcsLine(`SUMMARY:${"x".repeat(200)}`);
    for (const line of folded.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"x".repeat(200)}`);
  });
});

describe("tokens", () => {
  it("mints a prefixed 64-hex token whose stored form is its SHA-256", async () => {
    const t = await mintToken("exl_");
    expect(t.raw).toMatch(/^exl_[0-9a-f]{64}$/);
    expect(t.hash).toBe(await sha256Hex(t.raw));
    expect(t.hash).not.toContain(t.raw.slice(4));
  });

  it("rejects malformed, wrong-prefix and id-shaped tokens before any lookup", () => {
    expect(isWellFormedToken(`exl_${"a".repeat(64)}`, "exl_")).toBe(true);
    expect(isWellFormedToken(`exf_${"a".repeat(64)}`, "exl_")).toBe(false);
    expect(isWellFormedToken(`exl_${"a".repeat(32)}`, "exl_")).toBe(false);
    expect(isWellFormedToken(null, "exl_")).toBe(false);
  });
});

describe("document checks", () => {
  it("accepts a PDF or image up to 10 MB and nothing else", () => {
    expect(checkDocument("application/pdf", 1000, "card.pdf").ok).toBe(true);
    expect(checkDocument("image/jpeg; charset=binary", 1000, "x.jpg").ok).toBe(true);
    expect(checkDocument("text/html", 1000, "x.html").ok).toBe(false);
    expect(checkDocument("application/pdf", 0, "x.pdf").ok).toBe(false);
    expect(checkDocument("application/pdf", 10 * 1024 * 1024 + 1, "x.pdf").ok).toBe(false);
  });

  it("puts the tenant in the key and never trusts the filename", () => {
    expect(documentKey(ORG, ITEM, "d")).toBe(`${ORG}/${ITEM}/d`);
    expect(safeFilename("../../etc/pass\"wd")).toBe("passwd");
    expect(safeFilename("")).toBe("document");
  });
});

/** A repository double with real single-use semantics for the renewal link. */
function publicHarness(tokenHash: string) {
  let consumed = false;
  const writes: string[] = [];
  const events: string[] = [];
  const link: ExpiryRenewalLink = {
    id: "33333333-3333-4333-8333-333333333333",
    orgId: ORG,
    itemId: ITEM,
    createdBy: null,
    expiresAt: new Date("2026-10-15T00:00:00.000Z"),
    consumedAt: null,
    createdAt: NOW,
  };
  const item = {
    id: ITEM,
    orgId: ORG,
    projectId: null,
    name: "OSHA 10 card",
    kind: "certification",
    issuer: null,
    identifier: "SECRET-NUMBER",
    holderName: "Sam",
    holderEmail: "sam@x.test",
    status: "expiring",
    expiresOn: "2026-10-20",
  } as unknown as ExpiryItem;
  const expiryRepo = {
    findRenewalLinkByHash: async (hash: string) =>
      hash === tokenHash && !consumed ? { ok: true, value: link } : { ok: false, error: { kind: "not_found" } },
    consumeRenewalLink: async () => {
      if (consumed) return { ok: true, value: false };
      consumed = true;
      return { ok: true, value: true };
    },
    getItemById: async () => ({ ok: true, value: item }),
    skipPendingReminders: async () => {
      writes.push("skip");
      return { ok: true, value: 2 };
    },
    updateItem: async (_o: string, _i: string, patch: { expiresOn: string }) => {
      writes.push(`update:${patch.expiresOn}`);
      return { ok: true, value: { ...item, expiresOn: patch.expiresOn, status: "active" } };
    },
    createReminders: async (rows: unknown[]) => {
      writes.push(`ladder:${rows.length}`);
      return { ok: true, value: rows.length };
    },
  } as unknown as ExpiryRepository;
  const eventsRepo = {
    appendEventWithAudit: async (input: { event: { type: string; actorType: string } }) => {
      events.push(`${input.event.type}/${input.event.actorType}`);
      return { ok: true, value: {} };
    },
  } as unknown as EventsRepository;
  let n = 0;
  const deps = {
    expiryRepo,
    eventsRepo,
    now: () => NOW,
    generateId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  };
  return { deps, writes, events };
}

const env = { ENVIRONMENT: "test", PLATFORM_DB: {} as D1Database } as Env;

describe("the public renewal link", () => {
  it("shows the form with no Authorization, without the licence number, and is 404 once consumed", async () => {
    const token = `exl_${"c".repeat(64)}`;
    const h = publicHarness(await sha256Hex(token));
    const form = await routePublicIngress(
      new Request(`https://expiry.internal/ingress/expirio/renew?token=${token}`),
      env,
      "req_1",
      "/ingress/expirio/renew",
      h.deps,
    );
    expect(form.status).toBe(200);
    const text = await form.text();
    expect(text).toContain("OSHA 10 card");
    expect(text).not.toContain("SECRET-NUMBER");
    expect(text).not.toContain("sam@x.test");

    const submit = await routePublicIngress(
      new Request("https://expiry.internal/ingress/expirio/renew", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, expiresOn: "2028-10-20" }),
      }),
      env,
      "req_2",
      "/ingress/expirio/renew",
      h.deps,
    );
    expect(submit.status).toBe(200);
    expect(h.writes).toEqual(["skip", "update:2028-10-20", "ladder:5"]);
    expect(h.events).toEqual(["expiry.item.renewed/renewal_link"]);

    const again = await routePublicIngress(
      new Request(`https://expiry.internal/ingress/expirio/renew?token=${token}`),
      env,
      "req_3",
      "/ingress/expirio/renew",
      h.deps,
    );
    expect(again.status).toBe(404);
  });

  it("refuses a past date without burning the link", async () => {
    const token = `exl_${"d".repeat(64)}`;
    const h = publicHarness(await sha256Hex(token));
    const bad = await routePublicIngress(
      new Request("https://expiry.internal/ingress/expirio/renew", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, expiresOn: "2026-09-01" }),
      }),
      env,
      "req_4",
      "/ingress/expirio/renew",
      h.deps,
    );
    expect(bad.status).toBe(422);
    const form = await routePublicIngress(
      new Request(`https://expiry.internal/ingress/expirio/renew?token=${token}`),
      env,
      "req_5",
      "/ingress/expirio/renew",
      h.deps,
    );
    expect(form.status).toBe(200);
  });

  it("answers 404 for a malformed token without touching the database", async () => {
    const res = await routePublicIngress(
      new Request("https://expiry.internal/ingress/expirio/calendar.ics?token=nope"),
      env,
      "req_6",
      "/ingress/expirio/calendar.ics",
    );
    expect(res.status).toBe(404);
  });
});

describe("router — EX3 authenticated routes need an actor", () => {
  const ORG_ID = "org_11111111111141118111111111111111";
  it.each([
    ["GET", `/v1/organizations/${ORG_ID}/expiry-feeds`],
    ["POST", `/v1/organizations/${ORG_ID}/expiry-items/exi_22222222222242228222222222222222/renewal-links`],
    ["GET", `/v1/organizations/${ORG_ID}/expiry-documents/exd_22222222222242228222222222222222/content`],
  ])("%s %s without actor headers is 401", async (method, path) => {
    const res = await route(new Request(`https://expiry.internal${path}`, { method }), env);
    expect(res.status).toBe(401);
  });
});
