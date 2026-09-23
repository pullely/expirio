import { validateItemBody } from "@expiry-worker/validate";

describe("validateItemBody — create", () => {
  const ok = { name: "State pharmacy licence", expiresOn: "2027-03-31" };

  it("accepts the minimum an operator must type", () => {
    const result = validateItemBody(ok, false);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.name).toBe("State pharmacy licence");
      expect(result.value.kind).toBe("license");
    }
  });

  it("requires a name and a real expiry date", () => {
    const result = validateItemBody({}, false);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(Object.keys(result.fields).sort()).toEqual(["expiresOn", "name"]);
    }
  });

  it("refuses a body that is not an object", () => {
    expect(validateItemBody("nope", false).valid).toBe(false);
    expect(validateItemBody(null, false).valid).toBe(false);
  });

  it("refuses a kind outside the enum", () => {
    const result = validateItemBody({ ...ok, kind: "vibes" }, false);
    expect(result.valid).toBe(false);
  });

  it("trims and lowercases the two email fields, and rejects non-emails", () => {
    const result = validateItemBody(
      { ...ok, holderEmail: "  Dana@Clinic.Example  ", managerEmail: "boss@clinic.example" },
      false,
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.holderEmail).toBe("dana@clinic.example");
      expect(result.value.managerEmail).toBe("boss@clinic.example");
    }
    expect(validateItemBody({ ...ok, holderEmail: "not-an-email" }, false).valid).toBe(false);
  });

  it("treats an empty optional string as null rather than as empty text", () => {
    const result = validateItemBody({ ...ok, issuer: "   " }, false);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.issuer).toBeNull();
  });

  it("refuses an issue date after the expiry date", () => {
    const result = validateItemBody({ ...ok, issuedOn: "2027-04-01" }, false);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.fields.issuedOn).toBeDefined();
  });
});

describe("validateItemBody — patch", () => {
  it("allows a body that omits the required fields", () => {
    const result = validateItemBody({ notes: "renewed by post" }, true);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.name).toBeUndefined();
      expect(result.value.kind).toBeUndefined();
    }
  });

  it("still validates the fields it is given", () => {
    expect(validateItemBody({ expiresOn: "2026-02-30" }, true).valid).toBe(false);
    expect(validateItemBody({ name: "" }, true).valid).toBe(false);
  });

  it("distinguishes an explicit null from an absent field", () => {
    const result = validateItemBody({ managerEmail: null }, true);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.managerEmail).toBeNull();
      expect("holderEmail" in result.value).toBe(false);
    }
  });
});
