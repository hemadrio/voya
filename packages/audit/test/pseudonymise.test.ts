/**
 * Unit tests for WO-041 GDPR pseudonymisation — packages/audit/src/pseudonymise.ts
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { deriveActorSurrogate, pseudonymiseAuditActor } from "../src/pseudonymise.js";
import type { PseudonymiseTxClient } from "../src/pseudonymise.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SALT = "at-least-sixteen-chars-salt";

function expectedSurrogate(actorId: string, salt: string): string {
  return createHash("sha256").update(salt + actorId, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// In-memory tx stub — tracks $executeRaw calls
// ---------------------------------------------------------------------------

interface RawCall {
  actorId: string;
  surrogate: string;
}

function makeStubTx(rowsUpdated = 3): { tx: PseudonymiseTxClient; calls: RawCall[] } {
  const calls: RawCall[] = [];

  const tx: PseudonymiseTxClient = {
    async $executeRaw(strings, ...values) {
      // The template literal produces:
      //   SELECT pseudonymise_audit_actor($1::text, $2::text)
      // values[0] = actorId, values[1] = surrogate
      calls.push({ actorId: values[0] as string, surrogate: values[1] as string });
      return rowsUpdated;
    },
  };

  return { tx, calls };
}

// ---------------------------------------------------------------------------
// deriveActorSurrogate
// ---------------------------------------------------------------------------

describe("deriveActorSurrogate", () => {
  it("returns a 64-character hex string", () => {
    const result = deriveActorSurrogate("user-uuid-123", VALID_SALT);
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same inputs yield identical surrogate", () => {
    const a = deriveActorSurrogate("user-uuid-123", VALID_SALT);
    const b = deriveActorSurrogate("user-uuid-123", VALID_SALT);
    expect(a).toBe(b);
  });

  it("different actorIds produce different surrogates", () => {
    const a = deriveActorSurrogate("user-aaa", VALID_SALT);
    const b = deriveActorSurrogate("user-bbb", VALID_SALT);
    expect(a).not.toBe(b);
  });

  it("different salts produce different surrogates for the same actorId", () => {
    const a = deriveActorSurrogate("user-uuid-123", "salt-one-valid-long");
    const b = deriveActorSurrogate("user-uuid-123", "salt-two-valid-long");
    expect(a).not.toBe(b);
  });

  it("matches the reference SHA-256 computation", () => {
    const actorId = "user-uuid-ref";
    const expected = expectedSurrogate(actorId, VALID_SALT);
    expect(deriveActorSurrogate(actorId, VALID_SALT)).toBe(expected);
  });

  it("throws when salt is shorter than 16 characters", () => {
    expect(() => deriveActorSurrogate("user-123", "tooshort")).toThrow(
      /ACTOR_PSEUDONYM_SALT must be at least 16 characters/,
    );
  });

  it("throws when salt is empty string", () => {
    expect(() => deriveActorSurrogate("user-123", "")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// pseudonymiseAuditActor
// ---------------------------------------------------------------------------

describe("pseudonymiseAuditActor", () => {
  it("returns the derived surrogate and rows-updated count", async () => {
    const { tx } = makeStubTx(5);
    const result = await pseudonymiseAuditActor(tx, "user-uuid-456", VALID_SALT);

    expect(result.surrogate).toBe(expectedSurrogate("user-uuid-456", VALID_SALT));
    expect(result.rowsUpdated).toBe(5);
  });

  it("passes actorId and surrogate to $executeRaw in the correct order", async () => {
    const { tx, calls } = makeStubTx(2);
    await pseudonymiseAuditActor(tx, "user-uuid-789", VALID_SALT);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.actorId).toBe("user-uuid-789");
    expect(calls[0]!.surrogate).toBe(expectedSurrogate("user-uuid-789", VALID_SALT));
  });

  it("is idempotent — calling twice yields the same surrogate and no extra rows", async () => {
    // Simulates DB-level idempotency: second call updates 0 rows
    // because the WHERE actor_id <> surrogate guard eliminates them.
    let callCount = 0;
    const tx: PseudonymiseTxClient = {
      async $executeRaw(_strings, ..._values) {
        callCount++;
        return callCount === 1 ? 3 : 0;
      },
    };

    const r1 = await pseudonymiseAuditActor(tx, "user-uuid-idem", VALID_SALT);
    const r2 = await pseudonymiseAuditActor(tx, "user-uuid-idem", VALID_SALT);

    expect(r1.surrogate).toBe(r2.surrogate);
    expect(r1.rowsUpdated).toBe(3);
    expect(r2.rowsUpdated).toBe(0); // idempotent: no rows matched on second call
  });

  it("actor_id is replaced, not deleted — rows count reflects updates not deletes", async () => {
    const { tx, calls } = makeStubTx(7);
    const { rowsUpdated } = await pseudonymiseAuditActor(tx, "user-to-erase", VALID_SALT);

    // We only UPDATE rows; we never delete them.
    // The returned count is from the SP, not a DELETE count.
    expect(rowsUpdated).toBe(7);
    expect(calls[0]!.actorId).toBe("user-to-erase");
    // surrogate is an opaque hex — not the original actorId
    expect(calls[0]!.surrogate).not.toBe("user-to-erase");
  });

  it("propagates salt-length error from deriveActorSurrogate", async () => {
    const { tx } = makeStubTx(0);
    await expect(pseudonymiseAuditActor(tx, "user-123", "short")).rejects.toThrow(
      /ACTOR_PSEUDONYM_SALT must be at least 16 characters/,
    );
  });
});
