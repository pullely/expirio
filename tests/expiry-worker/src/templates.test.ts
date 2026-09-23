import { EXPIRY_ITEM_KINDS } from "@saas/contracts/expiry";
import {
  TEMPLATE_CATALOG,
  addMonths,
  findTemplate,
  selectTemplateItems,
} from "@expiry-worker/template-catalog";
import { validateApplyTemplateBody } from "@expiry-worker/validate";

describe("the vertical template catalogue", () => {
  it("carries clinic, trades and childcare", () => {
    expect(TEMPLATE_CATALOG.map((t) => t.key)).toEqual(["clinic", "trades", "childcare"]);
  });

  it("names the credentials each vertical is sold on", () => {
    const names = (key: string) => findTemplate(key)!.items.map((i) => i.name).join(" | ");
    expect(names("clinic")).toMatch(/DEA/);
    expect(names("clinic")).toMatch(/CPR/);
    expect(names("clinic")).toMatch(/State professional licence/);
    expect(names("trades")).toMatch(/EPA 608/);
    expect(names("trades")).toMatch(/OSHA 10/);
    expect(names("childcare")).toMatch(/childcare licence/);
  });

  it("uses only kinds the items table accepts, unique keys, and a positive validity", () => {
    for (const t of TEMPLATE_CATALOG) {
      const keys = new Set(t.items.map((i) => i.key));
      expect(keys.size).toBe(t.items.length);
      for (const i of t.items) {
        expect(EXPIRY_ITEM_KINDS).toContain(i.kind);
        expect(i.validityMonths).toBeGreaterThan(0);
      }
    }
  });

  it("returns null for an unknown vertical", () => {
    expect(findTemplate("bakery")).toBeNull();
  });

  it("narrows to the chosen rows and reports keys it does not know", () => {
    const clinic = findTemplate("clinic")!;
    expect(selectTemplateItems(clinic, undefined).items).toHaveLength(clinic.items.length);
    const some = selectTemplateItems(clinic, ["cpr-bls", "nope"]);
    expect(some.items.map((i) => i.key)).toEqual(["cpr-bls"]);
    expect(some.unknown).toEqual(["nope"]);
  });
});

describe("addMonths", () => {
  it("adds calendar months and clamps to the month's end", () => {
    expect(addMonths("2026-01-15", 12)).toBe("2027-01-15");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2027-12-31", 2)).toBe("2028-02-29");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
  });
});

describe("validateApplyTemplateBody", () => {
  it("accepts an empty body", () => {
    expect(validateApplyTemplateBody({}).valid).toBe(true);
    expect(validateApplyTemplateBody(undefined).valid).toBe(true);
  });
  it("lower-cases emails and rejects bad ones", () => {
    const ok = validateApplyTemplateBody({ holderEmail: "Dr.Ng@Clinic.Test" });
    expect(ok.valid && ok.value.holderEmail).toBe("dr.ng@clinic.test");
    expect(validateApplyTemplateBody({ managerEmail: "nope" }).valid).toBe(false);
  });
  it("rejects a malformed item list", () => {
    expect(validateApplyTemplateBody({ itemKeys: "cpr-bls" }).valid).toBe(false);
    expect(validateApplyTemplateBody({ itemKeys: [1] }).valid).toBe(false);
  });
});
