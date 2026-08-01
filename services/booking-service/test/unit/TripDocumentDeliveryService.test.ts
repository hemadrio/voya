/**
 * Unit tests for TripDocumentDeliveryService (WO-055, AC10).
 *
 * Covers:
 *   - Successful publish: 202 result with requestId, eventId, status QUEUED
 *   - Ownership denial: DENIED audit row written, nothing published, 403 thrown
 *   - Unknown itinerary: 404 thrown, no audit
 *   - Zero CONFIRMED precondition: 409 thrown, nothing published
 *   - Recipient resolved from user record (not from request)
 *   - Unverified email: 409 thrown
 *   - Deterministic event ID: same inside 5-min bucket, different across buckets
 *   - Publish failure: retryable error, no ACCEPTED audit row
 *   - Envelope contents: correlationId, userId as group key, itineraryId + locale in payload
 *   - No email address in payload (AC5)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TripDocumentDeliveryService,
  deriveEventId,
} from "../../src/domain/TripDocumentDeliveryService.js";
import {
  makeMockDeliveryRepo,
  makeMockUserEmailRepo,
  makeMockQueue,
  makeMockSecurityWriter,
  SYNTH_OWNER_USER_ID,
  SYNTH_ITINERARY_CONFIRMED_ID,
  SYNTH_ITINERARY_PENDING_ONLY_ID,
  SYNTH_VERIFIED_EMAIL,
  SYNTH_CORRELATION_ID,
} from "../fixtures/document-send-fixtures.js";
import type { QueueMessageEnvelope } from "@travel/contracts";

const ACTOR = { id: SYNTH_OWNER_USER_ID, role: "traveler" };
const FIXED_TIME = new Date("2026-08-01T10:00:00.000Z");
const FIXED_CLOCK = () => FIXED_TIME;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService(opts: {
  scenario?: "confirmed" | "pending-only" | "other-user" | "not-found";
  emailMissing?: boolean;
  emailVerified?: boolean;
  queueShouldFail?: boolean;
}) {
  const { repo, auditRows } = makeMockDeliveryRepo(opts.scenario ?? "confirmed");
  const userEmailRepo = makeMockUserEmailRepo({
    missing: opts.emailMissing,
    emailVerified: opts.emailVerified ?? true,
  });
  const { queue, published } = makeMockQueue({ shouldFail: opts.queueShouldFail });
  const { writer, events: securityEvents } = makeMockSecurityWriter();

  const svc = new TripDocumentDeliveryService(
    repo,
    userEmailRepo,
    queue,
    writer,
    FIXED_CLOCK,
  );

  return { svc, auditRows, published, securityEvents };
}

// ---------------------------------------------------------------------------
// Successful publish
// ---------------------------------------------------------------------------

describe("requestDocumentSend — success path", () => {
  it("returns 202 result with requestId, eventId, and status QUEUED", async () => {
    const { svc } = makeService({});
    const result = await svc.requestDocumentSend(
      SYNTH_ITINERARY_CONFIRMED_ID,
      SYNTH_OWNER_USER_ID,
      ACTOR,
      SYNTH_CORRELATION_ID,
      "en",
    );
    expect(result.status).toBe("QUEUED");
    expect(result.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(result.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(result.reference).toBe(SYNTH_CORRELATION_ID);
  });

  it("publishes to the itinerary.document.requested topic", async () => {
    const { svc, published } = makeService({});
    await svc.requestDocumentSend(
      SYNTH_ITINERARY_CONFIRMED_ID,
      SYNTH_OWNER_USER_ID,
      ACTOR,
      SYNTH_CORRELATION_ID,
    );
    expect(published).toHaveLength(1);
    expect(published[0]?.topic).toBe("itinerary.document.requested");
  });

  it("writes an ACCEPTED audit row after successful publish", async () => {
    const { svc, auditRows } = makeService({});
    await svc.requestDocumentSend(
      SYNTH_ITINERARY_CONFIRMED_ID,
      SYNTH_OWNER_USER_ID,
      ACTOR,
      SYNTH_CORRELATION_ID,
    );
    const accepted = auditRows.find((r) => r.data.action === "DOCUMENT_SEND_ACCEPTED");
    expect(accepted).toBeDefined();
    expect(accepted?.data.actorId).toBe(SYNTH_OWNER_USER_ID);
  });
});

// ---------------------------------------------------------------------------
// Envelope contents (AC5)
// ---------------------------------------------------------------------------

describe("envelope contents", () => {
  it("carries eventType, correlationId, userId, itineraryId and locale", async () => {
    const { svc, published } = makeService({});
    await svc.requestDocumentSend(
      SYNTH_ITINERARY_CONFIRMED_ID,
      SYNTH_OWNER_USER_ID,
      ACTOR,
      SYNTH_CORRELATION_ID,
      "fr",
    );
    const envelope = published[0]?.envelope as QueueMessageEnvelope;
    expect(envelope.eventType).toBe("itinerary.document.requested");
    expect(envelope.correlationId).toBe(SYNTH_CORRELATION_ID);
    expect(envelope.userId).toBe(SYNTH_OWNER_USER_ID);
    const payload = envelope.payload as Record<string, unknown>;
    expect(payload["itineraryId"]).toBe(SYNTH_ITINERARY_CONFIRMED_ID);
    expect(payload["locale"]).toBe("fr");
  });

  it("does not include the email address in the envelope payload (AC5)", async () => {
    const { svc, published } = makeService({});
    await svc.requestDocumentSend(
      SYNTH_ITINERARY_CONFIRMED_ID,
      SYNTH_OWNER_USER_ID,
      ACTOR,
      SYNTH_CORRELATION_ID,
    );
    const envelope = published[0]?.envelope as QueueMessageEnvelope;
    const payloadStr = JSON.stringify(envelope.payload);
    expect(payloadStr).not.toContain(SYNTH_VERIFIED_EMAIL);
    expect(payloadStr).not.toContain("email");
  });
});

// ---------------------------------------------------------------------------
// Ownership denial (AC3)
// ---------------------------------------------------------------------------

describe("requestDocumentSend — ownership denial", () => {
  it("throws 403 when the itinerary is owned by another user", async () => {
    const { svc } = makeService({ scenario: "other-user" });
    await expect(
      svc.requestDocumentSend(
        "b0000001-0000-4000-8000-000000000003",
        SYNTH_OWNER_USER_ID,
        ACTOR,
        SYNTH_CORRELATION_ID,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("writes a DENIED audit row on ownership failure", async () => {
    const { svc, auditRows } = makeService({ scenario: "other-user" });
    await svc.requestDocumentSend(
      "b0000001-0000-4000-8000-000000000003",
      SYNTH_OWNER_USER_ID,
      ACTOR,
      SYNTH_CORRELATION_ID,
    ).catch(() => {});
    const denied = auditRows.find((r) => r.data.action === "DOCUMENT_SEND_DENIED");
    expect(denied).toBeDefined();
  });

  it("records a security event on ownership failure", async () => {
    const { svc, securityEvents } = makeService({ scenario: "other-user" });
    await svc.requestDocumentSend(
      "b0000001-0000-4000-8000-000000000003",
      SYNTH_OWNER_USER_ID,
      ACTOR,
      SYNTH_CORRELATION_ID,
    ).catch(() => {});
    expect(securityEvents).toHaveLength(1);
    expect(securityEvents[0]).toMatchObject({ decision: "DENY", operation: "SEND_DOCUMENT" });
  });

  it("publishes nothing on ownership failure", async () => {
    const { svc, published } = makeService({ scenario: "other-user" });
    await svc.requestDocumentSend(
      "b0000001-0000-4000-8000-000000000003",
      SYNTH_OWNER_USER_ID,
      ACTOR,
      SYNTH_CORRELATION_ID,
    ).catch(() => {});
    expect(published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unknown itinerary (AC3)
// ---------------------------------------------------------------------------

describe("requestDocumentSend — unknown itinerary", () => {
  it("throws 404 for an itinerary that does not exist", async () => {
    const { svc } = makeService({ scenario: "not-found" });
    await expect(
      svc.requestDocumentSend(
        "00000000-0000-4000-8000-000000000099",
        SYNTH_OWNER_USER_ID,
        ACTOR,
        SYNTH_CORRELATION_ID,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("writes no audit row for a not-found itinerary", async () => {
    const { svc, auditRows } = makeService({ scenario: "not-found" });
    await svc.requestDocumentSend(
      "00000000-0000-4000-8000-000000000099",
      SYNTH_OWNER_USER_ID,
      ACTOR,
      SYNTH_CORRELATION_ID,
    ).catch(() => {});
    expect(auditRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Zero CONFIRMED precondition (AC4)
// ---------------------------------------------------------------------------

describe("requestDocumentSend — zero CONFIRMED precondition", () => {
  it("throws 409 when the itinerary has no CONFIRMED bookings", async () => {
    const { svc } = makeService({ scenario: "pending-only" });
    await expect(
      svc.requestDocumentSend(
        SYNTH_ITINERARY_PENDING_ONLY_ID,
        SYNTH_OWNER_USER_ID,
        ACTOR,
        SYNTH_CORRELATION_ID,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("publishes nothing when the precondition fails", async () => {
    const { svc, published } = makeService({ scenario: "pending-only" });
    await svc.requestDocumentSend(
      SYNTH_ITINERARY_PENDING_ONLY_ID,
      SYNTH_OWNER_USER_ID,
      ACTOR,
      SYNTH_CORRELATION_ID,
    ).catch(() => {});
    expect(published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Recipient resolution (AC2)
// ---------------------------------------------------------------------------

describe("requestDocumentSend — recipient resolution", () => {
  it("throws 409 when the user has no verified email", async () => {
    const { svc } = makeService({ emailVerified: false });
    await expect(
      svc.requestDocumentSend(
        SYNTH_ITINERARY_CONFIRMED_ID,
        SYNTH_OWNER_USER_ID,
        ACTOR,
        SYNTH_CORRELATION_ID,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("throws 409 when the user record has no email at all", async () => {
    const { svc } = makeService({ emailMissing: true });
    await expect(
      svc.requestDocumentSend(
        SYNTH_ITINERARY_CONFIRMED_ID,
        SYNTH_OWNER_USER_ID,
        ACTOR,
        SYNTH_CORRELATION_ID,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("publishes nothing when the user has no verified email", async () => {
    const { svc, published } = makeService({ emailVerified: false });
    await svc.requestDocumentSend(
      SYNTH_ITINERARY_CONFIRMED_ID,
      SYNTH_OWNER_USER_ID,
      ACTOR,
      SYNTH_CORRELATION_ID,
    ).catch(() => {});
    expect(published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deterministic event ID (AC7)
// ---------------------------------------------------------------------------

describe("deriveEventId — deterministic dedup window", () => {
  it("returns the same event ID for the same itinerary within the same 5-minute bucket", () => {
    const bucket = 1_000_000; // arbitrary fixed bucket
    const id1 = deriveEventId(SYNTH_ITINERARY_CONFIRMED_ID, bucket);
    const id2 = deriveEventId(SYNTH_ITINERARY_CONFIRMED_ID, bucket);
    expect(id1).toBe(id2);
  });

  it("returns a different event ID when the time bucket changes", () => {
    const bucket = 1_000_000;
    const id1 = deriveEventId(SYNTH_ITINERARY_CONFIRMED_ID, bucket);
    const id2 = deriveEventId(SYNTH_ITINERARY_CONFIRMED_ID, bucket + 1);
    expect(id1).not.toBe(id2);
  });

  it("returns a valid UUID v4 (version and variant bits set correctly)", () => {
    const id = deriveEventId(SYNTH_ITINERARY_CONFIRMED_ID, 12345);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("returns different IDs for different itinerary IDs in the same bucket", () => {
    const bucket = 1_000_000;
    const id1 = deriveEventId(SYNTH_ITINERARY_CONFIRMED_ID, bucket);
    const id2 = deriveEventId(SYNTH_ITINERARY_PENDING_ONLY_ID, bucket);
    expect(id1).not.toBe(id2);
  });

  it("service reuses the same event ID for two rapid requests within the same window", async () => {
    const { svc } = makeService({});
    const r1 = await svc.requestDocumentSend(
      SYNTH_ITINERARY_CONFIRMED_ID,
      SYNTH_OWNER_USER_ID,
      ACTOR,
      SYNTH_CORRELATION_ID,
    );
    const r2 = await svc.requestDocumentSend(
      SYNTH_ITINERARY_CONFIRMED_ID,
      SYNTH_OWNER_USER_ID,
      ACTOR,
      SYNTH_CORRELATION_ID,
    );
    // Both use the same fixed clock → same bucket → same eventId
    expect(r1.eventId).toBe(r2.eventId);
    // requestId is always different (randomUUID per call)
    expect(r1.requestId).not.toBe(r2.requestId);
  });
});

// ---------------------------------------------------------------------------
// Publish failure (AC9)
// ---------------------------------------------------------------------------

describe("requestDocumentSend — publish failure", () => {
  it("throws a retryable error when the queue is unavailable", async () => {
    const { svc } = makeService({ queueShouldFail: true });
    await expect(
      svc.requestDocumentSend(
        SYNTH_ITINERARY_CONFIRMED_ID,
        SYNTH_OWNER_USER_ID,
        ACTOR,
        SYNTH_CORRELATION_ID,
      ),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("does not write an ACCEPTED audit row when publish fails (AC9)", async () => {
    const { svc, auditRows } = makeService({ queueShouldFail: true });
    await svc.requestDocumentSend(
      SYNTH_ITINERARY_CONFIRMED_ID,
      SYNTH_OWNER_USER_ID,
      ACTOR,
      SYNTH_CORRELATION_ID,
    ).catch(() => {});
    const accepted = auditRows.find((r) => r.data.action === "DOCUMENT_SEND_ACCEPTED");
    expect(accepted).toBeUndefined();
  });
});
