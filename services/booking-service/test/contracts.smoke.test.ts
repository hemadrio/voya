import { describe, expect, it } from "vitest";
import { CreateBookingRequestSchema } from "@travel/contracts/booking";
import type { CreateBookingRequest } from "@travel/contracts/booking";
import fixture from "./fixtures/create-booking-request.json" with { type: "json" };

/**
 * Downstream smoke test (AC11): proves @travel/contracts resolves through
 * the pnpm workspace protocol from a real consuming service, and that a
 * committed fixture payload validates end to end using the package's
 * emitted types and schemas — not a locally re-declared interface.
 */
describe("booking-service consumes @travel/contracts", () => {
  it("resolves CreateBookingRequestSchema and validates a committed fixture", () => {
    const result = CreateBookingRequestSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  it("rejects a fixture mutated to violate the contract (empty passengers)", () => {
    const invalid: CreateBookingRequest = { ...fixture, passengers: [] } as unknown as CreateBookingRequest;
    const result = CreateBookingRequestSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});
