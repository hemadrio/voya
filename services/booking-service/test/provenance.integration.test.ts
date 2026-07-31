/**
 * AC9 (partial) — Integration test: ProvenanceGuard produces the correct
 * OFFER_NOT_BOOKABLE (422) error envelope for ILLUSTRATIVE provenance.
 *
 * This test exercises the full path from the domain guard through the shared
 * error serialiser to the wire envelope — no live database required.
 */
import { describe, expect, it } from "vitest";
import { assertBookable } from "../src/domain/ProvenanceGuard.js";
import { serialiseError, ErrorEnvelopeSchema } from "@travel/contracts/errors";

const TRACE_ID = "prov-guard-trace-001";

describe("ProvenanceGuard → error serialiser integration", () => {
  it("ILLUSTRATIVE offer produces OFFER_NOT_BOOKABLE 422 envelope", () => {
    let caughtError: unknown;
    try {
      assertBookable({ provenance: "ILLUSTRATIVE", bookable: true });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();

    const { envelope, status } = serialiseError(caughtError, TRACE_ID);
    expect(status).toBe(422);
    expect(envelope.error.code).toBe("OFFER_NOT_BOOKABLE");
    expect(envelope.reference).toBe(TRACE_ID);
    expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("unknown provenance produces OFFER_NOT_BOOKABLE 422 envelope", () => {
    let caughtError: unknown;
    try {
      assertBookable({ provenance: "UNKNOWN_PARTNER_XYZ", bookable: true });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();

    const { envelope, status } = serialiseError(caughtError, TRACE_ID);
    expect(status).toBe(422);
    expect(envelope.error.code).toBe("OFFER_NOT_BOOKABLE");
    expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("bookable=false offer produces OFFER_NOT_BOOKABLE 422 envelope", () => {
    let caughtError: unknown;
    try {
      assertBookable({ provenance: "AMADEUS", bookable: false });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();

    const { envelope, status } = serialiseError(caughtError, TRACE_ID);
    expect(status).toBe(422);
    expect(envelope.error.code).toBe("OFFER_NOT_BOOKABLE");
    expect(envelope.error.message).toMatch(/non-bookable|not bookable/i);
    expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("envelope from OFFER_NOT_BOOKABLE does not leak provenance value or SQL detail", () => {
    let caughtError: unknown;
    try {
      assertBookable({ provenance: "ILLUSTRATIVE", bookable: false });
    } catch (err) {
      caughtError = err;
    }

    const { envelope } = serialiseError(caughtError, TRACE_ID);
    const serialised = JSON.stringify(envelope);
    // Must not contain SQL fragments or internal field values
    expect(serialised).not.toContain("pg:");
    expect(serialised).not.toContain("unique constraint");
    // The code must be the documented platform code, not an internal exception class name
    expect(envelope.error.code).toBe("OFFER_NOT_BOOKABLE");
  });

  it("valid AMADEUS offer with bookable=true does not throw", () => {
    expect(() => assertBookable({ provenance: "AMADEUS", bookable: true })).not.toThrow();
  });
});
