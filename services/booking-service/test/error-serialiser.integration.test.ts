/**
 * AC10 — Integration test: one service wired to the shared serialiser.
 *
 * Validates that:
 *  1. An invalid booking request body produces the documented error envelope
 *     with code VALIDATION_FAILED and status 400.
 *  2. The `reference` in the envelope equals the trace identifier supplied by
 *     the caller (simulating the value the gateway would inject via X-Trace-Id).
 *  3. A DomainError raised by a service function produces the correct status
 *     and envelope, with the reference matching the injected traceId.
 *  4. An unknown error never leaks internal details.
 *
 * This test intentionally uses only @travel/contracts — no Express, no HTTP
 * layer — to validate the serialiser end-to-end from a real consuming service
 * without requiring a running server (Express wiring is covered by WO-003).
 */
import { describe, expect, it } from "vitest";
import { CreateBookingRequestSchema } from "@travel/contracts/booking";
import {
  serialiseError,
  lifecycleConflict,
  supplierRejected,
  ErrorEnvelopeSchema,
} from "@travel/contracts/errors";

const TRACE_ID = "booking-svc-trace-0001";

describe("booking-service — error serialiser integration", () => {
  it("invalid booking request body produces VALIDATION_FAILED with status 400", () => {
    // Simulate the Zod parse that the service's boundary validator would run.
    const parseResult = CreateBookingRequestSchema.safeParse({
      bookingType: "FLIGHT",
      offerId: "offer_01",
      // offerPrice intentionally omitted → required field missing
      currency: "USD",
      passengers: [],
      contactEmail: "not-an-email",
      idempotencyKey: "idem_1",
    });

    expect(parseResult.success).toBe(false);
    if (parseResult.success) return;

    const { envelope, status } = serialiseError(parseResult.error, TRACE_ID);

    expect(status).toBe(400);
    expect(envelope.error.code).toBe("VALIDATION_FAILED");
    expect(envelope.reference).toBe(TRACE_ID);

    // The envelope must conform to the documented shape.
    const validated = ErrorEnvelopeSchema.safeParse(envelope);
    expect(validated.success).toBe(true);
  });

  it("reference equals the injected trace identifier", () => {
    const parseResult = CreateBookingRequestSchema.safeParse({});
    expect(parseResult.success).toBe(false);
    if (parseResult.success) return;

    const { envelope } = serialiseError(parseResult.error, TRACE_ID);
    expect(envelope.reference).toBe(TRACE_ID);
  });

  it("lifecycle conflict from the booking state machine produces 409 envelope", () => {
    const err = lifecycleConflict(
      "Booking is CONFIRMED; permitted transitions are CANCELLED or REFUNDED"
    );
    const { envelope, status } = serialiseError(err, TRACE_ID);

    expect(status).toBe(409);
    expect(envelope.error.code).toBe("LIFECYCLE_CONFLICT");
    expect(envelope.reference).toBe(TRACE_ID);
    expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("supplier rejection produces 422 with the supplier's message", () => {
    const err = supplierRejected("Offer AMF-1234 has expired");
    const { envelope, status } = serialiseError(err, TRACE_ID);

    expect(status).toBe(422);
    expect(envelope.error.code).toBe("SUPPLIER_REJECTED");
    expect(envelope.error.message).toBe("Offer AMF-1234 has expired");
    expect(envelope.reference).toBe(TRACE_ID);
  });

  it("unknown internal error never leaks details and produces 500", () => {
    const err = new Error("pg: duplicate key value violates unique constraint users_pkey");
    const { envelope, status } = serialiseError(err, TRACE_ID);

    expect(status).toBe(500);
    expect(envelope.error.code).toBe("INTERNAL_ERROR");
    // Must not leak the SQL detail
    expect(JSON.stringify(envelope)).not.toContain("unique constraint");
    expect(JSON.stringify(envelope)).not.toContain("users_pkey");
    expect(envelope.reference).toBe(TRACE_ID);
    expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("envelope with a generated reference is always non-empty when no trace is provided", () => {
    const parseResult = CreateBookingRequestSchema.safeParse({});
    expect(parseResult.success).toBe(false);
    if (parseResult.success) return;

    const { envelope } = serialiseError(parseResult.error);
    expect(envelope.reference.length).toBeGreaterThan(0);
    expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});
