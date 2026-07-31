import { describe, expect, it } from "vitest";
import {
  CORRELATION_ID_REQUIRED_MESSAGE,
  CURRENCY_CODE_MESSAGE,
  IATA_CODE_MESSAGE,
  ISO_DATE_MESSAGE,
  IDENTIFIER_REQUIRED_MESSAGE,
  MONEY_INVALID_MESSAGE,
  MONEY_POSITIVE_MESSAGE,
  MONEY_PRECISION_MESSAGE,
  correlationId,
  currencyCode,
  iataCode,
  identifier,
  isOnOrAfter,
  isStrictlyAfter,
  isStrictlyFuture,
  isoDateString,
  paginationSchema,
  positiveMoney,
} from "../../src/common/primitives.js";

describe("iataCode", () => {
  it("accepts a valid uppercase 3-letter code", () => {
    const result = iataCode.safeParse("JFK");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("JFK");
  });

  it("normalises lowercase input and surrounding whitespace to uppercase", () => {
    const result = iataCode.safeParse("  jfk  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("JFK");
  });

  it("rejects a code that is still invalid after normalisation with the exact BR-11 message", () => {
    const result = iataCode.safeParse("NEWYORK");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(IATA_CODE_MESSAGE);
      expect(result.error.issues[0]?.path).toEqual([]);
    }
  });

  it("rejects a 2-letter code", () => {
    const result = iataCode.safeParse("NY");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(IATA_CODE_MESSAGE);
  });

  it("rejects digits", () => {
    const result = iataCode.safeParse("J1K");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(IATA_CODE_MESSAGE);
  });
});

describe("isoDateString", () => {
  it("parses a valid ISO-8601 string and coerces it to a Date", () => {
    const result = isoDateString.safeParse("2030-06-01T00:00:00.000Z");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeInstanceOf(Date);
      expect(result.data.toISOString()).toBe("2030-06-01T00:00:00.000Z");
    }
  });

  it("rejects a non-ISO date string", () => {
    const result = isoDateString.safeParse("06/01/2030");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(ISO_DATE_MESSAGE);
  });

  it("rejects a non-string value", () => {
    const result = isoDateString.safeParse(12345);
    expect(result.success).toBe(false);
  });
});

describe("currencyCode", () => {
  it("accepts a valid 3-letter currency code", () => {
    const result = currencyCode.safeParse("usd");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("USD");
  });

  it("rejects an invalid currency code with the exact message", () => {
    const result = currencyCode.safeParse("US");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(CURRENCY_CODE_MESSAGE);
  });
});

describe("positiveMoney", () => {
  it("accepts a number with two decimal places", () => {
    const result = positiveMoney.safeParse(412.5);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(412.5);
  });

  it("accepts a string amount and normalises it to a number", () => {
    const result = positiveMoney.safeParse("412.50");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(412.5);
  });

  it("rejects a string with more than two decimal places", () => {
    const result = positiveMoney.safeParse("412.5678");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(MONEY_PRECISION_MESSAGE);
  });

  it("rejects zero", () => {
    const result = positiveMoney.safeParse(0);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(MONEY_POSITIVE_MESSAGE);
  });

  it("rejects a negative amount", () => {
    const result = positiveMoney.safeParse(-10);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(MONEY_POSITIVE_MESSAGE);
  });

  it("rejects a non-numeric string", () => {
    const result = positiveMoney.safeParse("not-a-number");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(MONEY_PRECISION_MESSAGE);
  });

  it("rejects NaN-producing input distinct from precision failures", () => {
    const result = positiveMoney.safeParse(Number.NaN);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(MONEY_INVALID_MESSAGE);
  });
});

describe("identifier", () => {
  it("accepts a non-empty string", () => {
    expect(identifier.safeParse("booking_123").success).toBe(true);
  });

  it("rejects an empty string with the exact message", () => {
    const result = identifier.safeParse("   ");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(IDENTIFIER_REQUIRED_MESSAGE);
  });
});

describe("correlationId", () => {
  it("accepts a non-empty string", () => {
    expect(correlationId.safeParse("corr_123").success).toBe(true);
  });

  it("rejects an empty string with the exact message", () => {
    const result = correlationId.safeParse("");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(CORRELATION_ID_REQUIRED_MESSAGE);
  });
});

describe("paginationSchema", () => {
  it("defaults page and pageSize when omitted", () => {
    const result = paginationSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ page: 1, pageSize: 20 });
  });

  it("rejects a pageSize above the max bound", () => {
    const result = paginationSchema.safeParse({ page: 1, pageSize: 101 });
    expect(result.success).toBe(false);
  });
});

describe("date-order boundary decisions", () => {
  // Documented decision: a value exactly equal to the reference instant is
  // NOT considered "in the future" / "after" — every wire schema that uses
  // these helpers (flight departure, car pickup, hotel check-out/in, car
  // dropoff/pickup) inherits this exact, tested boundary behaviour.
  const reference = new Date("2030-01-01T00:00:00.000Z");

  it("isStrictlyFuture treats a value equal to the reference instant as NOT future", () => {
    expect(isStrictlyFuture(new Date(reference.getTime()), reference)).toBe(false);
  });

  it("isStrictlyFuture treats a value 1ms after the reference instant as future", () => {
    expect(isStrictlyFuture(new Date(reference.getTime() + 1), reference)).toBe(true);
  });

  it("isStrictlyFuture treats a value before the reference instant as NOT future", () => {
    expect(isStrictlyFuture(new Date(reference.getTime() - 1), reference)).toBe(false);
  });

  it("isStrictlyAfter treats equal instants as NOT after (same-day stays must fail)", () => {
    expect(isStrictlyAfter(new Date(reference.getTime()), reference)).toBe(false);
  });

  it("isOnOrAfter treats equal instants as satisfying the bound (same-day return trips are allowed)", () => {
    expect(isOnOrAfter(new Date(reference.getTime()), reference)).toBe(true);
  });
});
