/**
 * Unit tests for BookingEntitlementService (WO-044).
 *
 * The service is pure — no I/O, no DB — so tests run without any setup.
 * Coverage: all role × operation × ownership combinations required by AC8/AC9.
 */

import { describe, it, expect } from "vitest";
import { BookingEntitlementService } from "../BookingEntitlementService.js";
import type { EntitlementActor, BookingOwnershipMeta } from "../BookingEntitlementService.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER_ID = "usr_owner_abc123";
const OTHER_ID = "usr_other_xyz789";

const ownerMeta: BookingOwnershipMeta = { ownerId: OWNER_ID };

const travelerOwner: EntitlementActor = { id: OWNER_ID, role: "traveler" };
const travelerOther: EntitlementActor = { id: OTHER_ID, role: "traveler" };
const supportAgent: EntitlementActor = { id: "usr_support_s1", role: "support_agent" };
const systemActor: EntitlementActor = { id: "system", role: "system" };
const unknownRole: EntitlementActor = { id: "usr_anon", role: "guest" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const svc = new BookingEntitlementService();

// ---------------------------------------------------------------------------
// canRead
// ---------------------------------------------------------------------------

describe("BookingEntitlementService.canRead", () => {
  it("allows traveler who owns the booking", () => {
    const result = svc.canRead(travelerOwner, ownerMeta);
    expect(result.allowed).toBe(true);
  });

  it("denies traveler who does NOT own the booking", () => {
    const result = svc.canRead(travelerOther, ownerMeta);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("OWNERSHIP_PREDICATE_FAILED");
    }
  });

  it("allows support_agent regardless of ownership", () => {
    const result = svc.canRead(supportAgent, ownerMeta);
    expect(result.allowed).toBe(true);
  });

  it("denies system role on READ endpoint", () => {
    const result = svc.canRead(systemActor, ownerMeta);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("SYSTEM_ROLE_NOT_PERMITTED_ON_READ_ENDPOINT");
    }
  });

  it("denies unknown role", () => {
    const result = svc.canRead(unknownRole, ownerMeta);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("UNKNOWN_ROLE");
    }
  });
});

// ---------------------------------------------------------------------------
// canModify
// ---------------------------------------------------------------------------

describe("BookingEntitlementService.canModify", () => {
  it("allows traveler who owns the booking", () => {
    const result = svc.canModify(travelerOwner, ownerMeta);
    expect(result.allowed).toBe(true);
  });

  it("denies traveler who does NOT own the booking", () => {
    const result = svc.canModify(travelerOther, ownerMeta);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("OWNERSHIP_PREDICATE_FAILED");
    }
  });

  it("denies support_agent from modifying (identity-document protection)", () => {
    const result = svc.canModify(supportAgent, ownerMeta);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("SUPPORT_AGENT_CANNOT_MODIFY");
    }
  });

  it("denies system role on MODIFY endpoint", () => {
    const result = svc.canModify(systemActor, ownerMeta);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("SYSTEM_ROLE_NOT_PERMITTED_ON_MODIFY_ENDPOINT");
    }
  });

  it("denies unknown role", () => {
    const result = svc.canModify(unknownRole, ownerMeta);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/^UNKNOWN_ROLE:/);
    }
  });
});

// ---------------------------------------------------------------------------
// canCancel
// ---------------------------------------------------------------------------

describe("BookingEntitlementService.canCancel", () => {
  it("allows traveler who owns the booking", () => {
    const result = svc.canCancel(travelerOwner, ownerMeta);
    expect(result.allowed).toBe(true);
  });

  it("denies traveler who does NOT own the booking", () => {
    const result = svc.canCancel(travelerOther, ownerMeta);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("OWNERSHIP_PREDICATE_FAILED");
    }
  });

  it("allows support_agent to cancel any booking", () => {
    const result = svc.canCancel(supportAgent, ownerMeta);
    expect(result.allowed).toBe(true);
  });

  it("denies system role on CANCEL endpoint", () => {
    const result = svc.canCancel(systemActor, ownerMeta);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("SYSTEM_ROLE_NOT_PERMITTED_ON_CANCEL_ENDPOINT");
    }
  });

  it("denies unknown role", () => {
    const result = svc.canCancel(unknownRole, ownerMeta);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/^UNKNOWN_ROLE:/);
    }
  });
});

// ---------------------------------------------------------------------------
// Defence-in-depth: domain check denies even without middleware
// ---------------------------------------------------------------------------

describe("BookingEntitlementService — defence-in-depth (AC-9)", () => {
  it("denies cross-owner read even when called without any middleware context", () => {
    // Simulate bypassed middleware: domain check called directly
    const maliciousActor: EntitlementActor = { id: "usr_hacker", role: "traveler" };
    const victimMeta: BookingOwnershipMeta = { ownerId: "usr_victim" };
    const result = svc.canRead(maliciousActor, victimMeta);
    expect(result.allowed).toBe(false);
  });

  it("denies support_agent modify even when called without any middleware context", () => {
    const result = svc.canModify(supportAgent, ownerMeta);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("SUPPORT_AGENT_CANNOT_MODIFY");
    }
  });

  it("denies system read even when called without any middleware context", () => {
    const result = svc.canRead(systemActor, ownerMeta);
    expect(result.allowed).toBe(false);
  });

  it("denies system modify even when called without any middleware context", () => {
    const result = svc.canModify(systemActor, ownerMeta);
    expect(result.allowed).toBe(false);
  });

  it("denies system cancel even when called without any middleware context", () => {
    const result = svc.canCancel(systemActor, ownerMeta);
    expect(result.allowed).toBe(false);
  });

  it("a traveler with a different id is always denied regardless of booking meta content", () => {
    const stranger: EntitlementActor = { id: "usr_stranger", role: "traveler" };
    const meta: BookingOwnershipMeta = { ownerId: "usr_real_owner" };
    expect(svc.canRead(stranger, meta).allowed).toBe(false);
    expect(svc.canModify(stranger, meta).allowed).toBe(false);
    expect(svc.canCancel(stranger, meta).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Symmetry: ownership check is evaluated BEFORE role check
// (traveler own booking always wins; support_agent never allowed to modify)
// ---------------------------------------------------------------------------

describe("BookingEntitlementService — role × ownership matrix", () => {
  const cases = [
    { actor: travelerOwner,  op: "READ",   expected: true  },
    { actor: travelerOwner,  op: "MODIFY", expected: true  },
    { actor: travelerOwner,  op: "CANCEL", expected: true  },
    { actor: travelerOther,  op: "READ",   expected: false },
    { actor: travelerOther,  op: "MODIFY", expected: false },
    { actor: travelerOther,  op: "CANCEL", expected: false },
    { actor: supportAgent,   op: "READ",   expected: true  },
    { actor: supportAgent,   op: "MODIFY", expected: false },
    { actor: supportAgent,   op: "CANCEL", expected: true  },
    { actor: systemActor,    op: "READ",   expected: false },
    { actor: systemActor,    op: "MODIFY", expected: false },
    { actor: systemActor,    op: "CANCEL", expected: false },
    { actor: unknownRole,    op: "READ",   expected: false },
    { actor: unknownRole,    op: "MODIFY", expected: false },
    { actor: unknownRole,    op: "CANCEL", expected: false },
  ] as const;

  for (const { actor, op, expected } of cases) {
    it(`${actor.role}(${actor.id === OWNER_ID ? "owner" : "non-owner"}).can${op.charAt(0) + op.slice(1).toLowerCase()} → ${expected}`, () => {
      let result;
      if (op === "READ")   result = svc.canRead(actor, ownerMeta);
      if (op === "MODIFY") result = svc.canModify(actor, ownerMeta);
      if (op === "CANCEL") result = svc.canCancel(actor, ownerMeta);
      expect(result!.allowed).toBe(expected);
    });
  }
});
