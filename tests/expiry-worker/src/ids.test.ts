import {
  expiryItemPublicId,
  expiryReminderPublicId,
  parseExpiryItemPublicId,
  parseExpiryReminderPublicId,
  parseOrgPublicId,
  generateRequestId,
} from "@expiry-worker/ids";

const UUID = "0189bd7c-6f9a-4b1f-9c3a-1f2e3d4c5b6a";

describe("public ids", () => {
  it("round-trips an item id through its prefix", () => {
    const publicId = expiryItemPublicId(UUID);
    expect(publicId.startsWith("exi_")).toBe(true);
    expect(publicId).toHaveLength(4 + 32);
    expect(parseExpiryItemPublicId(publicId)).toBe(UUID);
  });

  it("round-trips a reminder id", () => {
    const publicId = expiryReminderPublicId(UUID);
    expect(publicId.startsWith("exr_")).toBe(true);
    expect(parseExpiryReminderPublicId(publicId)).toBe(UUID);
  });

  it("refuses another context's prefix — an org id is not an item id", () => {
    expect(parseExpiryItemPublicId(`org_${expiryItemPublicId(UUID).slice(4)}`)).toBeNull();
    expect(parseOrgPublicId(expiryItemPublicId(UUID))).toBeNull();
  });

  it("refuses malformed input rather than throwing", () => {
    expect(parseExpiryItemPublicId("exi_")).toBeNull();
    expect(parseExpiryItemPublicId("exi_nothex")).toBeNull();
    expect(parseExpiryItemPublicId("")).toBeNull();
  });

  it("mints request ids in the baseline's shape", () => {
    expect(generateRequestId()).toMatch(/^req_[0-9a-f]{24}$/);
  });
});
