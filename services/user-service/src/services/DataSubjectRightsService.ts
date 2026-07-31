/**
 * DataSubjectRightsService — GDPR data subject rights (BR-16).
 *
 * Implements the four subject rights:
 *   - Access/rectification: GET and PATCH /v1/me
 *   - Export:               POST /v1/me/export / GET /v1/me/export/{id}
 *   - Erasure:              DELETE /v1/me
 *
 * Pure domain layer: no Express, no Prisma, no AWS SDK imports.
 * All side effects are injected via interfaces.
 *
 * Security invariants:
 *   - Subject identifier comes exclusively from the verified token (injected
 *     by the caller). No method accepts a client-supplied user ID.
 *   - Cross-subject access throws FORBIDDEN and writes a security audit event.
 *   - Audit records are never deleted — only the actor linkage is broken via
 *     pseudonymisation (HMAC of subject ID keyed by a secrets-held value).
 *   - Financial records subject to the 7-year obligation are retained in
 *     pseudonymised form and explicitly reported in the erasure response.
 */

import { createHmac } from "node:crypto";
import type {
  ProfilePatch,
  ExportAccepted,
  ExportStatus,
  ErasureAccepted,
  ErasureOutcomeItem,
} from "@travel/contracts/privacy";
import type { Profile, TravelPreferences } from "@travel/contracts/user";
import { getDsrExportEntries, getErasureExcludedEntries } from "@travel/contracts/retention";

// ---------------------------------------------------------------------------
// Injectable interfaces — no framework or DB imports here
// ---------------------------------------------------------------------------

export interface UserProfileRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  createdAt: Date;
  erasedAt: Date | null;
}

export interface ProfileRepository {
  findById(userId: string): Promise<UserProfileRow | null>;
  updateProfile(userId: string, patch: { firstName?: string; lastName?: string; email?: string }): Promise<UserProfileRow>;
}

export interface PreferencesRepository {
  findByUserId(userId: string): Promise<TravelPreferences | null>;
}

export interface DataSubjectRequestRow {
  id: string;
  userId: string;
  type: string;
  status: string;
  requestedAt: Date;
  completedAt: Date | null;
  outcomeSummary: Record<string, unknown> | null;
  correlationId: string;
  downloadUrl: string | null;
  expiresAt: Date | null;
}

export interface DataSubjectRequestRepository {
  create(row: Omit<DataSubjectRequestRow, "completedAt" | "downloadUrl" | "expiresAt">): Promise<DataSubjectRequestRow>;
  findById(requestId: string): Promise<DataSubjectRequestRow | null>;
  findPendingExport(userId: string): Promise<DataSubjectRequestRow | null>;
  updateStatus(
    requestId: string,
    status: string,
    extra?: { completedAt?: Date; downloadUrl?: string; expiresAt?: Date; outcomeSummary?: Record<string, unknown> },
  ): Promise<void>;
  countCompletedInWindow(userId: string, type: string, windowMs: number): Promise<number>;
}

export interface SessionRevocationRepository {
  revokeAllForUser(userId: string): Promise<number>;
  addToDenylist(jti: string, expiryMs: number): Promise<void>;
  listActiveJtis(userId: string): Promise<string[]>;
}

export interface ActorPseudonymRepository {
  record(entry: { subjectId: string; pseudonymReference: string; erasedAt: Date }): Promise<void>;
  findBySubject(subjectId: string): Promise<{ pseudonymReference: string } | null>;
}

export interface AuditWriter {
  write(entry: {
    action: string;
    actorId: string;
    actorRole: string;
    resourceType: string;
    resourceId: string;
    occurredAt: Date;
    correlationId: string;
    outcome: "success" | "denied" | "failed";
    detail?: Record<string, unknown>;
  }): Promise<void>;
}

export interface ExportJobPublisher {
  enqueue(job: { requestId: string; subjectId: string; correlationId: string }): Promise<void>;
}

export interface CryptoEraser {
  destroySubjectKey(subjectId: string): Promise<{ keyId: string; destroyedAt: Date }>;
}

export interface RightsRateLimiter {
  /** Returns true if the subject may proceed; false if rate-limited. */
  checkExportAllowed(subjectId: string): Promise<boolean>;
}

export interface Clock {
  now(): Date;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Redacted fields that must never appear in any export archive payload.
 * Checked before upload as a defence-in-depth assertion.
 */
export const EXPORT_EXCLUDED_KEYS = new Set([
  "passwordHash",
  "password",
  "cardNumber",
  "cvv",
  "cvc",
  "rawToken",
  "refreshTokenHash",
  "passportNumber",
  "dateOfBirth",
  "wrappedDek",
  "ciphertext",
]);

export function assertNoExcludedKeys(obj: unknown, path = ""): void {
  if (obj === null || typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const fullPath = path ? `${path}.${key}` : key;
    if (EXPORT_EXCLUDED_KEYS.has(key)) {
      throw new Error(`Export archive contains excluded key: ${fullPath}`);
    }
    assertNoExcludedKeys(value, fullPath);
  }
}

/**
 * Compute the HMAC pseudonym for an actor reference.
 * Uses HMAC-SHA256 keyed by the pseudonymisationKey.
 * The result is a deterministic hex digest — same input always gives same output,
 * but without the key the original subject ID cannot be derived.
 */
export function computePseudonym(subjectId: string, pseudonymisationKey: string): string {
  return createHmac("sha256", pseudonymisationKey).update(subjectId).digest("hex");
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

export interface DataSubjectRightsServiceDeps {
  profileRepo: ProfileRepository;
  preferencesRepo: PreferencesRepository;
  dsrRepo: DataSubjectRequestRepository;
  sessionRepo: SessionRevocationRepository;
  pseudonymRepo: ActorPseudonymRepository;
  auditWriter: AuditWriter;
  exportPublisher: ExportJobPublisher;
  cryptoEraser: CryptoEraser;
  rateLimiter: RightsRateLimiter;
  clock: Clock;
  /** HMAC key for pseudonymisation — loaded from secrets at startup, never logged. */
  pseudonymisationKey: string;
  /** Days until the scheduled purge completes (from retention config). */
  purgeWindowDays: number;
}

export class DataSubjectRightsService {
  private readonly deps: DataSubjectRightsServiceDeps;

  constructor(deps: DataSubjectRightsServiceDeps) {
    this.deps = deps;
  }

  // ── Profile read ───────────────────────────────────────────────────────────

  async getMyProfile(subjectId: string, correlationId: string): Promise<Profile> {
    const row = await this.deps.profileRepo.findById(subjectId);
    if (!row || row.erasedAt !== null) {
      await this.writeAudit({
        action: "dsr.access",
        actorId: subjectId,
        resourceId: subjectId,
        correlationId,
        outcome: "failed",
        detail: { reason: "profile_not_found" },
      });
      throw Object.assign(new Error("Profile not found"), { code: "NOT_FOUND", httpStatus: 404 });
    }
    await this.writeAudit({ action: "dsr.access", actorId: subjectId, resourceId: subjectId, correlationId, outcome: "success" });
    return this.toProfile(row);
  }

  // ── Profile rectification ─────────────────────────────────────────────────

  async patchMyProfile(subjectId: string, patch: ProfilePatch, correlationId: string): Promise<Profile> {
    const updated = await this.deps.profileRepo.updateProfile(subjectId, patch);
    await this.writeAudit({
      action: "dsr.rectification",
      actorId: subjectId,
      resourceId: subjectId,
      correlationId,
      outcome: "success",
      detail: { patchedFields: Object.keys(patch) },
    });
    return this.toProfile(updated);
  }

  // ── Export request ────────────────────────────────────────────────────────

  async requestExport(subjectId: string, correlationId: string): Promise<ExportAccepted> {
    // Rate-limit check (re-checked in the service even when the gateway already throttles)
    const allowed = await this.deps.rateLimiter.checkExportAllowed(subjectId);
    if (!allowed) {
      await this.writeAudit({ action: "dsr.export_request", actorId: subjectId, resourceId: subjectId, correlationId, outcome: "denied", detail: { reason: "rate_limited" } });
      throw Object.assign(new Error("Export rate limit exceeded"), { code: "RATE_LIMITED", httpStatus: 429 });
    }

    // Coalesce: reuse in-flight job if one is already queued/processing
    const pending = await this.deps.dsrRepo.findPendingExport(subjectId);
    if (pending) {
      return {
        requestId: pending.id,
        status: "queued",
        estimatedCompletionAt: new Date(this.deps.clock.now().getTime() + 5 * 60_000),
      };
    }

    const requestId = this.newId();
    const now = this.deps.clock.now();
    await this.deps.dsrRepo.create({
      id: requestId,
      userId: subjectId,
      type: "export",
      status: "queued",
      requestedAt: now,
      outcomeSummary: null,
      correlationId,
    });

    await this.deps.exportPublisher.enqueue({ requestId, subjectId, correlationId });

    await this.writeAudit({ action: "dsr.export_request", actorId: subjectId, resourceId: requestId, correlationId, outcome: "success" });

    return {
      requestId,
      status: "queued",
      estimatedCompletionAt: new Date(now.getTime() + 5 * 60_000),
    };
  }

  // ── Export status ─────────────────────────────────────────────────────────

  async getExportStatus(subjectId: string, requestId: string, correlationId: string): Promise<ExportStatus> {
    const row = await this.deps.dsrRepo.findById(requestId);
    if (!row) {
      throw Object.assign(new Error(`Export request ${requestId} not found`), { code: "NOT_FOUND", httpStatus: 404 });
    }
    // Ownership check — deny-by-default
    if (row.userId !== subjectId) {
      await this.writeAudit({ action: "dsr.export_status", actorId: subjectId, resourceId: requestId, correlationId, outcome: "denied", detail: { reason: "cross_subject_access" } });
      throw Object.assign(new Error("Access denied"), { code: "FORBIDDEN", httpStatus: 403 });
    }

    return {
      requestId: row.id,
      status: row.status as ExportStatus["status"],
      downloadUrl: row.downloadUrl ?? undefined,
      expiresAt: row.expiresAt ?? undefined,
      requestedAt: row.requestedAt,
      completedAt: row.completedAt ?? undefined,
    };
  }

  // ── Erasure ───────────────────────────────────────────────────────────────

  async requestErasure(subjectId: string, correlationId: string): Promise<ErasureAccepted> {
    const now = this.deps.clock.now();
    const requestId = this.newId();
    const purgeAt = new Date(now.getTime() + this.deps.purgeWindowDays * 86_400_000);

    // 1. Revoke all sessions immediately
    const revokedCount = await this.deps.sessionRepo.revokeAllForUser(subjectId);

    // 2. Pseudonymise audit actor references before key destruction
    const pseudonym = computePseudonym(subjectId, this.deps.pseudonymisationKey);
    await this.deps.pseudonymRepo.record({
      subjectId,
      pseudonymReference: pseudonym,
      erasedAt: now,
    });

    // 3. Destroy the per-subject encryption key (crypto-erasure of identity docs)
    let keyDestroyedAt: Date | undefined;
    try {
      const result = await this.deps.cryptoEraser.destroySubjectKey(subjectId);
      keyDestroyedAt = result.destroyedAt;
    } catch (err) {
      // Key destruction failure aborts the erasure rather than silently proceeding
      await this.writeAudit({ action: "dsr.erasure", actorId: subjectId, resourceId: subjectId, correlationId, outcome: "failed", detail: { reason: "key_destruction_failed", error: String(err) } });
      throw Object.assign(new Error("Erasure failed: key destruction error"), { code: "INTERNAL_ERROR", httpStatus: 500 });
    }

    // 4. Build erasure outcome from the retention register
    const dsrEntries = getDsrExportEntries();
    const excludedEntries = getErasureExcludedEntries();
    const excludedIds = new Set(excludedEntries.map((e) => e.id));

    const erasedNow: ErasureOutcomeItem[] = [];
    const scheduled: ErasureOutcomeItem[] = [];
    const retained: ErasureOutcomeItem[] = [];

    for (const entry of dsrEntries) {
      if (excludedIds.has(entry.id)) {
        retained.push({
          category: entry.category,
          table: entry.table,
          disposition: "retained",
          retentionReason: entry.pseudonymisationRule ?? "audit_trail_immutability",
        });
      } else if (entry.erasureMethod === "crypto_erasure") {
        erasedNow.push({
          category: entry.category,
          table: entry.table,
          disposition: "erased_now",
        });
      } else if (entry.erasureMethod === "physical_delete") {
        scheduled.push({
          category: entry.category,
          table: entry.table,
          disposition: "scheduled",
          purgeAfter: purgeAt,
        });
      } else if (entry.erasureMethod === "pseudonymisation") {
        retained.push({
          category: entry.category,
          table: entry.table,
          disposition: "retained",
          retentionReason: entry.pseudonymisationRule ?? "pseudonymised",
        });
      } else {
        retained.push({
          category: entry.category,
          table: entry.table,
          disposition: "retained",
          retentionReason: "financial_record_7yr",
        });
      }
    }

    // 5. Record the DSR request
    await this.deps.dsrRepo.create({
      id: requestId,
      userId: subjectId,
      type: "erasure",
      status: "queued",
      requestedAt: now,
      outcomeSummary: {
        erasedNow: erasedNow.length,
        scheduled: scheduled.length,
        retained: retained.length,
        revokedSessions: revokedCount,
        keyDestroyedAt: keyDestroyedAt?.toISOString(),
        pseudonymReference: pseudonym,
      },
      correlationId,
    });

    await this.writeAudit({
      action: "dsr.erasure",
      actorId: subjectId,
      resourceId: requestId,
      correlationId,
      outcome: "success",
      detail: { revokedSessions: revokedCount, purgeAt: purgeAt.toISOString() },
    });

    return {
      requestId,
      scheduledPurgeAt: purgeAt,
      erasedNow,
      scheduled,
      retained,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private toProfile(row: UserProfileRow): Profile {
    return {
      id: row.id,
      email: row.email,
      firstName: row.firstName,
      lastName: row.lastName,
      role: row.role as Profile["role"],
      createdAt: row.createdAt,
    };
  }

  private async writeAudit(entry: {
    action: string;
    actorId: string;
    resourceId: string;
    correlationId: string;
    outcome: "success" | "denied" | "failed";
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await this.deps.auditWriter.write({
      ...entry,
      actorRole: "traveler",
      resourceType: "user",
      occurredAt: this.deps.clock.now(),
    });
  }

  private newId(): string {
    // crypto.randomUUID() — available in Node 14.17+
    return crypto.randomUUID();
  }
}
