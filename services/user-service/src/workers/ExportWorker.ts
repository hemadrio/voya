/**
 * ExportWorker — assembles a GDPR data subject export archive.
 *
 * Called by the queue consumer when a DSR export job is dequeued.
 * Responsibilities:
 *   1. Fetch the subject's profile, preferences, bookings, itineraries,
 *      travelers, and conversation history.
 *   2. Redact all fields excluded from export (passwords, card numbers, etc.).
 *   3. Validate the assembled archive against ExportArchiveManifestSchema
 *      as a defence-in-depth assertion before upload.
 *   4. Upload the archive to the configured object storage bucket using a
 *      short-lived, single-subject-scoped object key.
 *   5. Generate a short-lived signed download URL (max 1 hour).
 *   6. Update the DSR request row to status="ready" with the download URL.
 *
 * Security invariants maintained here:
 *   - assertNoExcludedKeys() throws if any redacted field survives assembly.
 *   - Object key includes the subjectId prefix — sharing or guessing is not possible.
 *   - Download URL lifetime is bounded by DOWNLOAD_URL_TTL_MS.
 *   - No full card number, CVV, password hash, or passport reference is included.
 */

import { ExportArchiveManifestSchema } from "@travel/contracts/privacy";
import {
  assertNoExcludedKeys,
  type DataSubjectRequestRepository,
  type AuditWriter,
} from "../services/DataSubjectRightsService.js";

export const DOWNLOAD_URL_TTL_MS = 60 * 60 * 1_000; // 1 hour

// ---------------------------------------------------------------------------
// Injectable interfaces (no AWS SDK / DB / Express imports)
// ---------------------------------------------------------------------------

export interface BookingExport {
  bookingId: string;
  status: string;
  offerSnapshot: Record<string, unknown>;
  passengers: Record<string, unknown>[];
  payments: {
    providerReference: string;
    cardBrand?: string;
    cardLast4?: string;
    amount: string;
    currency: string;
    status: string;
    createdAt: Date;
  }[];
  createdAt: Date;
}

export interface ExportDataLoader {
  loadProfile(subjectId: string): Promise<Record<string, unknown>>;
  loadPreferences(subjectId: string): Promise<Record<string, unknown> | null>;
  loadBookings(subjectId: string): Promise<BookingExport[]>;
  loadItineraries(subjectId: string): Promise<Record<string, unknown>[]>;
  loadTravelers(subjectId: string): Promise<Record<string, unknown>[]>;
  loadConversationHistory(subjectId: string): Promise<Record<string, unknown>[]>;
}

export interface ArchiveStorage {
  /** Upload the serialised archive and return a signed URL. */
  upload(opts: {
    subjectId: string;
    requestId: string;
    content: string;
    contentType: string;
    ttlMs: number;
  }): Promise<{ downloadUrl: string; expiresAt: Date }>;
}

export interface Clock {
  now(): Date;
}

export interface ExportWorkerDeps {
  dataLoader: ExportDataLoader;
  storage: ArchiveStorage;
  dsrRepo: DataSubjectRequestRepository;
  auditWriter: AuditWriter;
  clock: Clock;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export class ExportWorker {
  constructor(private readonly deps: ExportWorkerDeps) {}

  async process(job: { requestId: string; subjectId: string; correlationId: string }): Promise<void> {
    const { requestId, subjectId, correlationId } = job;
    const now = this.deps.clock.now();

    await this.deps.dsrRepo.updateStatus(requestId, "processing");

    try {
      // 1. Load all subject data
      const [profile, preferences, bookings, itineraries, travelers, conversationHistory] =
        await Promise.all([
          this.deps.dataLoader.loadProfile(subjectId),
          this.deps.dataLoader.loadPreferences(subjectId),
          this.deps.dataLoader.loadBookings(subjectId),
          this.deps.dataLoader.loadItineraries(subjectId),
          this.deps.dataLoader.loadTravelers(subjectId),
          this.deps.dataLoader.loadConversationHistory(subjectId),
        ]);

      // 2. Map bookings to archive shape (redact payment details — no full card number)
      const archiveBookings = bookings.map((b) => ({
        bookingId: b.bookingId,
        status: b.status,
        offerSnapshot: this.redactObject(b.offerSnapshot),
        passengers: b.passengers.map((p) => this.redactObject(p)),
        payments: b.payments.map((p) => ({
          providerReference: p.providerReference,
          cardBrand: p.cardBrand,
          cardLast4: p.cardLast4,
          amount: p.amount,
          currency: p.currency,
          status: p.status,
          createdAt: p.createdAt,
        })),
        createdAt: b.createdAt,
      }));

      // 3. Assemble archive
      const archive = {
        schemaVersion: "1.0" as const,
        subjectId,
        exportedAt: now,
        requestId,
        account: this.redactObject(profile),
        preferences: preferences ? this.redactObject(preferences) : null,
        bookings: archiveBookings,
        itineraries: itineraries.map((i) => this.redactObject(i)),
        travelers: travelers.map((t) => this.redactObject(t)),
        conversationHistory: conversationHistory.map((c) => this.redactObject(c)),
      };

      // 4. Defence-in-depth: assert no excluded keys survive redaction
      assertNoExcludedKeys(archive);

      // 5. Validate against the published contract schema
      const parseResult = ExportArchiveManifestSchema.safeParse(archive);
      if (!parseResult.success) {
        throw new Error(
          `Export archive failed schema validation: ${parseResult.error.message}`,
        );
      }

      // 6. Upload and get signed URL
      const { downloadUrl, expiresAt } = await this.deps.storage.upload({
        subjectId,
        requestId,
        content: JSON.stringify(parseResult.data, null, 2),
        contentType: "application/json",
        ttlMs: DOWNLOAD_URL_TTL_MS,
      });

      // 7. Mark ready
      await this.deps.dsrRepo.updateStatus(requestId, "ready", {
        completedAt: this.deps.clock.now(),
        downloadUrl,
        expiresAt,
        outcomeSummary: { exportedAt: now.toISOString() },
      });

      await this.deps.auditWriter.write({
        action: "dsr.export_complete",
        actorId: subjectId,
        actorRole: "traveler",
        resourceType: "export_archive",
        resourceId: requestId,
        occurredAt: this.deps.clock.now(),
        correlationId,
        outcome: "success",
      });
    } catch (err) {
      await this.deps.dsrRepo.updateStatus(requestId, "failed", {
        completedAt: this.deps.clock.now(),
        outcomeSummary: { error: String(err) },
      });

      await this.deps.auditWriter.write({
        action: "dsr.export_failed",
        actorId: subjectId,
        actorRole: "traveler",
        resourceType: "export_archive",
        resourceId: requestId,
        occurredAt: this.deps.clock.now(),
        correlationId,
        outcome: "failed",
        detail: { error: String(err) },
      });

      throw err;
    }
  }

  /**
   * Deep-clone an object removing any key that appears in EXPORT_EXCLUDED_KEYS.
   * Returns a new object — does not mutate the input.
   */
  private redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const EXCLUDED = new Set([
      "passwordHash", "password", "cardNumber", "cvv", "cvc",
      "rawToken", "refreshTokenHash", "passportNumber", "dateOfBirth",
      "wrappedDek", "ciphertext",
    ]);

    function redact(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(redact);
      if (value !== null && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (!EXCLUDED.has(k)) {
            result[k] = redact(v);
          }
        }
        return result;
      }
      return value;
    }

    return redact(obj) as Record<string, unknown>;
  }
}
