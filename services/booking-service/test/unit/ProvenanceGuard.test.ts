import { describe, expect, it } from "vitest";
import { assertBookable, checkBookable } from "../../src/domain/ProvenanceGuard.js";

describe("assertBookable", () => {
  describe("approved supplier provenances", () => {
    it("accepts AMADEUS offer when bookable=true", () => {
      expect(() => assertBookable({ provenance: "AMADEUS", bookable: true })).not.toThrow();
    });

    it("accepts RAPIDAPI_HOTEL offer when bookable=true", () => {
      expect(() => assertBookable({ provenance: "RAPIDAPI_HOTEL", bookable: true })).not.toThrow();
    });

    it("accepts RAPIDAPI_CAR offer when bookable=true", () => {
      expect(() => assertBookable({ provenance: "RAPIDAPI_CAR", bookable: true })).not.toThrow();
    });
  });

  describe("ILLUSTRATIVE offers — always rejected", () => {
    it("throws OFFER_NOT_BOOKABLE for ILLUSTRATIVE provenance", () => {
      expect(() => assertBookable({ provenance: "ILLUSTRATIVE", bookable: true })).toThrow();
    });

    it("attaches code OFFER_NOT_BOOKABLE", () => {
      try {
        assertBookable({ provenance: "ILLUSTRATIVE", bookable: true });
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as { code: string }).code).toBe("OFFER_NOT_BOOKABLE");
      }
    });

    it("includes provenance in the field property", () => {
      try {
        assertBookable({ provenance: "ILLUSTRATIVE", bookable: true });
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as { field: string }).field).toBe("provenance");
      }
    });
  });

  describe("unrecognised provenance strings", () => {
    it("throws for an unknown provenance", () => {
      expect(() => assertBookable({ provenance: "UNKNOWN_PARTNER", bookable: true })).toThrow();
    });

    it("attaches code OFFER_NOT_BOOKABLE for unknown provenance", () => {
      try {
        assertBookable({ provenance: "UNKNOWN_PARTNER", bookable: true });
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as { code: string }).code).toBe("OFFER_NOT_BOOKABLE");
      }
    });

    it("throws for an empty provenance string", () => {
      expect(() => assertBookable({ provenance: "", bookable: true })).toThrow();
    });
  });

  describe("bookable=false — rejected even for valid supplier provenance", () => {
    it("throws for AMADEUS offer with bookable=false", () => {
      expect(() => assertBookable({ provenance: "AMADEUS", bookable: false })).toThrow();
    });

    it("attaches code OFFER_NOT_BOOKABLE and field bookable", () => {
      try {
        assertBookable({ provenance: "AMADEUS", bookable: false });
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as { code: string }).code).toBe("OFFER_NOT_BOOKABLE");
        expect((err as { field: string }).field).toBe("bookable");
      }
    });
  });
});

describe("checkBookable", () => {
  it("returns null for a valid offer", () => {
    const result = checkBookable({ provenance: "AMADEUS", bookable: true });
    expect(result).toBeNull();
  });

  it("returns a DomainError for ILLUSTRATIVE provenance", () => {
    const err = checkBookable({ provenance: "ILLUSTRATIVE", bookable: true });
    expect(err).not.toBeNull();
    expect(err?.code).toBe("OFFER_NOT_BOOKABLE");
  });

  it("returns a DomainError for bookable=false", () => {
    const err = checkBookable({ provenance: "RAPIDAPI_HOTEL", bookable: false });
    expect(err).not.toBeNull();
    expect(err?.code).toBe("OFFER_NOT_BOOKABLE");
  });

  it("returns a DomainError for an unknown provenance", () => {
    const err = checkBookable({ provenance: "FAKE_PARTNER", bookable: true });
    expect(err).not.toBeNull();
    expect(err?.code).toBe("OFFER_NOT_BOOKABLE");
  });
});
