import { describe, expect, it } from "vitest";
import {
  validationFailed,
  unauthenticated,
  forbidden,
  notFound,
  conflict,
  lifecycleConflict,
  duplicateEmail,
  supplierRejected,
  rateLimited,
  supplierUnavailable,
  supplierTimeout,
  egressDenied,
  offerNotBookable,
} from "../../src/errors/domain-errors.js";
import type { DomainError } from "../../src/errors/domain-errors.js";

function isDomainError(err: unknown): err is DomainError {
  return err instanceof Error && "code" in err;
}

describe("validationFailed", () => {
  it("creates a DomainError with code VALIDATION_FAILED and optional field", () => {
    const err = validationFailed("Invalid airport code", "origin");
    expect(isDomainError(err)).toBe(true);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.message).toBe("Invalid airport code");
    expect(err.field).toBe("origin");
  });

  it("creates a DomainError without field when omitted", () => {
    const err = validationFailed("Validation failed");
    expect(err.field).toBeUndefined();
  });
});

describe("unauthenticated", () => {
  it("creates a DomainError with code UNAUTHENTICATED", () => {
    const err = unauthenticated();
    expect(err.code).toBe("UNAUTHENTICATED");
    expect(err.message).toBe("Authentication required");
  });

  it("accepts a custom message", () => {
    const err = unauthenticated("Token expired");
    expect(err.message).toBe("Token expired");
  });
});

describe("forbidden", () => {
  it("creates a DomainError with code FORBIDDEN", () => {
    const err = forbidden();
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toBe("Access denied");
  });
});

describe("notFound", () => {
  it("creates a DomainError with code NOT_FOUND", () => {
    const err = notFound();
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Resource not found");
  });

  it("accepts a field path", () => {
    const err = notFound("Booking not found", "bookingId");
    expect(err.field).toBe("bookingId");
  });
});

describe("conflict", () => {
  it("creates a DomainError with code CONFLICT", () => {
    const err = conflict("Duplicate itinerary");
    expect(err.code).toBe("CONFLICT");
  });
});

describe("lifecycleConflict", () => {
  it("creates a DomainError with code LIFECYCLE_CONFLICT", () => {
    const err = lifecycleConflict("Cannot cancel a CONFIRMED booking");
    expect(err.code).toBe("LIFECYCLE_CONFLICT");
    expect(err.message).toBe("Cannot cancel a CONFIRMED booking");
  });
});

describe("duplicateEmail", () => {
  it("creates a DomainError with code DUPLICATE_EMAIL and field 'email'", () => {
    const err = duplicateEmail();
    expect(err.code).toBe("DUPLICATE_EMAIL");
    expect(err.field).toBe("email");
  });
});

describe("supplierRejected", () => {
  it("creates a DomainError with code SUPPLIER_REJECTED", () => {
    const err = supplierRejected("Offer has expired");
    expect(err.code).toBe("SUPPLIER_REJECTED");
    expect(err.message).toBe("Offer has expired");
  });
});

describe("rateLimited", () => {
  it("creates a DomainError with code RATE_LIMITED", () => {
    const err = rateLimited();
    expect(err.code).toBe("RATE_LIMITED");
  });
});

describe("supplierUnavailable", () => {
  it("creates a DomainError with code SUPPLIER_UNAVAILABLE", () => {
    const err = supplierUnavailable();
    expect(err.code).toBe("SUPPLIER_UNAVAILABLE");
  });
});

describe("supplierTimeout", () => {
  it("creates a DomainError with code SUPPLIER_TIMEOUT", () => {
    const err = supplierTimeout();
    expect(err.code).toBe("SUPPLIER_TIMEOUT");
  });
});

describe("egressDenied", () => {
  it("creates a DomainError with code EGRESS_DENIED", () => {
    const err = egressDenied();
    expect(err.code).toBe("EGRESS_DENIED");
  });

  it("uses the default message when none is provided", () => {
    const err = egressDenied();
    expect(err.message).toMatch(/denied/i);
  });
});

describe("offerNotBookable", () => {
  it("creates a DomainError with code OFFER_NOT_BOOKABLE", () => {
    const err = offerNotBookable("Offer is illustrative.");
    expect(err.code).toBe("OFFER_NOT_BOOKABLE");
  });

  it("defaults field to 'provenance'", () => {
    const err = offerNotBookable("Offer is illustrative.");
    expect(err.field).toBe("provenance");
  });

  it("accepts a custom field name", () => {
    const err = offerNotBookable("Not bookable.", "bookable");
    expect(err.field).toBe("bookable");
  });

  it("uses the default message when none is provided", () => {
    const err = offerNotBookable();
    expect(err.message).toBeTruthy();
  });
});

describe("DomainError instanceof chain", () => {
  it("all factory results are instanceof Error", () => {
    const factories = [
      validationFailed("msg"),
      unauthenticated(),
      forbidden(),
      notFound(),
      conflict("msg"),
      lifecycleConflict("msg"),
      duplicateEmail(),
      supplierRejected("msg"),
      rateLimited(),
      supplierUnavailable(),
      supplierTimeout(),
      egressDenied(),
      offerNotBookable(),
    ];
    for (const err of factories) {
      expect(err instanceof Error).toBe(true);
    }
  });
});
