import { describe, expect, it } from "vitest";
import {
  SUPPLIER_PROVENANCES,
  BookingProvenanceSchema,
  AnyProvenanceSchema,
  isSupplierProvenance,
} from "../../src/booking/provenance.js";
import type { SupplierProvenance } from "../../src/booking/provenance.js";

describe("SUPPLIER_PROVENANCES", () => {
  it("includes AMADEUS, RAPIDAPI_HOTEL, RAPIDAPI_CAR", () => {
    expect(SUPPLIER_PROVENANCES).toContain("AMADEUS");
    expect(SUPPLIER_PROVENANCES).toContain("RAPIDAPI_HOTEL");
    expect(SUPPLIER_PROVENANCES).toContain("RAPIDAPI_CAR");
  });

  it("does not include ILLUSTRATIVE", () => {
    expect(SUPPLIER_PROVENANCES).not.toContain("ILLUSTRATIVE");
  });
});

describe("BookingProvenanceSchema", () => {
  it("accepts all supplier provenances", () => {
    for (const p of SUPPLIER_PROVENANCES) {
      expect(BookingProvenanceSchema.safeParse(p).success).toBe(true);
    }
  });

  it("accepts ILLUSTRATIVE", () => {
    expect(BookingProvenanceSchema.safeParse("ILLUSTRATIVE").success).toBe(true);
  });

  it("rejects an unknown provenance string", () => {
    expect(BookingProvenanceSchema.safeParse("FAKE_SUPPLIER").success).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(BookingProvenanceSchema.safeParse("").success).toBe(false);
  });
});

describe("AnyProvenanceSchema", () => {
  it("accepts any non-empty string up to 64 chars", () => {
    expect(AnyProvenanceSchema.safeParse("FUTURE_PARTNER").success).toBe(true);
    expect(AnyProvenanceSchema.safeParse("A".repeat(64)).success).toBe(true);
  });

  it("rejects empty string", () => {
    expect(AnyProvenanceSchema.safeParse("").success).toBe(false);
  });

  it("rejects strings longer than 64 chars", () => {
    expect(AnyProvenanceSchema.safeParse("A".repeat(65)).success).toBe(false);
  });
});

describe("isSupplierProvenance", () => {
  it("returns true for each approved supplier provenance", () => {
    for (const p of SUPPLIER_PROVENANCES) {
      expect(isSupplierProvenance(p)).toBe(true);
    }
  });

  it("returns false for ILLUSTRATIVE", () => {
    expect(isSupplierProvenance("ILLUSTRATIVE")).toBe(false);
  });

  it("returns false for an unknown string", () => {
    expect(isSupplierProvenance("UNKNOWN")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isSupplierProvenance("")).toBe(false);
  });

  it("acts as a type guard — narrows to SupplierProvenance", () => {
    const p: string = "AMADEUS";
    if (isSupplierProvenance(p)) {
      const _typed: SupplierProvenance = p; // type-checks
      expect(_typed).toBe("AMADEUS");
    }
  });
});
