/**
 * TripDocumentService — document generation orchestration (WO-054).
 *
 * Responsibilities:
 *   1. Ownership predicate check (404 → 403 distinction).
 *   2. At-least-one-CONFIRMED precondition (409 if unmet).
 *   3. Document size and booking-count caps (resource protection).
 *   4. Persist a trip_document row in PENDING status before rendering.
 *   5. Project the itinerary read model through the allow-list (no PII).
 *   6. Render the PDF via PdfRendererPort (abstract — no library import).
 *   7. Store to object storage via DocumentStoragePort.
 *   8. Update the document row to READY + persist byte size.
 *   9. Issue a short-lived signed URL (never logged).
 *  10. Write an append-only audit row for every attempt.
 *
 * Framework-free: no Express, no Prisma, no AWS SDK imports here.
 * All dependencies are injected via constructor.
 */

import {
  notFound,
  forbidden,
  conflict,
} from "@travel/contracts/errors";
import type { AuditTxClient } from "./AuditWriter.js";
import { writeAudit } from "./AuditWriter.js";
import type { PdfRendererPort } from "../adapters/PdfRendererAdapter.js";
import { PdfRenderError } from "../adapters/PdfRendererAdapter.js";
import type { DocumentStoragePort } from "../adapters/DocumentStorageAdapter.js";
import { DocumentStorageError } from "../adapters/DocumentStorageAdapter.js";
import type { SecurityEventWriter } from "./SecurityEventWriter.js";
import {
  projectToTripDocument,
  type ItineraryDocumentInput,
} from "./tripDocumentProjection.js";
import type { DocumentResponse, DocumentStatus } from "@travel/contracts/documents";

// ---------------------------------------------------------------------------
// Maximum resource limits (AC resource-protection requirement)
// ---------------------------------------------------------------------------

const MAX_BOOKINGS_PER_DOCUMENT = 50;
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024; // 20 MB
const SIGNED_URL_EXPIRY_SECONDS = 900; // 15 minutes (AC7)

// ---------------------------------------------------------------------------
// Repository port — defines what the service needs from persistence
// ---------------------------------------------------------------------------

/** Minimal itinerary row needed for document generation. */
export interface ItineraryDocumentRow {
  id: string;
  userId: string;
  name: string;
  startDate: Date | null;
  endDate: Date | null;
  bookings: ItineraryBookingDocumentRow[];
}

export interface ItineraryBookingDocumentRow {
  id: string;
  bookingType: string;
  status: string;
  totalPrice: { toString(): string };
  currency: string;
  supplier?: string | null;
  confirmationReference?: string | null;
  travelStartDate?: Date | null;
  travelEndDate?: Date | null;
  origin?: string | null;
  destination?: string | null;
  /** Name-only passenger records — MUST NOT contain dateOfBirth or passportNumber. */
  travellers: Array<{ givenName: string; familyName: string }>;
}

/** Trip document row for persistence. */
export interface TripDocumentRow {
  id: string;
  itineraryId: string;
  userId: string;
  status: DocumentStatus;
  storageKey: string | null;
  byteSize: number | null;
  generatedAt: Date | null;
  purgeAfter: Date | null;
  correlationId: string;
  createdAt: Date;
}

/** Prisma-compatible slice for document operations. */
export interface TripDocumentPrismaClient {
  tripDocument: {
    create(args: {
      data: {
        itineraryId: string;
        userId: string;
        status: string;
        correlationId: string;
        purgeAfter?: Date;
      };
    }): Promise<TripDocumentRow>;
    update(args: {
      where: { id: string };
      data: {
        status: string;
        storageKey?: string;
        byteSize?: number;
        generatedAt?: Date;
      };
    }): Promise<TripDocumentRow>;
    findFirst(args: {
      where: { id: string; itineraryId: string; userId: string };
    }): Promise<TripDocumentRow | null>;
    findMany(args: {
      where: { itineraryId: string; userId: string };
      orderBy?: { createdAt: 'desc' };
      take?: number;
    }): Promise<TripDocumentRow[]>;
  };
}

export interface TripDocumentRepositoryPort {
  /** Fetch the itinerary with name-only passenger data (never dateOfBirth/passportNumber). */
  findItineraryForDocument(
    itineraryId: string,
    userId: string,
  ): Promise<ItineraryDocumentRow | null>;
  /** Fetch itinerary existence without ownership filter (for 404-vs-403). */
  findItineraryById(itineraryId: string): Promise<{ id: string; userId: string } | null>;
  /** Persist a new trip_document row in PENDING. */
  createDocument(
    itineraryId: string,
    userId: string,
    correlationId: string,
    purgeAfter: Date,
  ): Promise<TripDocumentRow>;
  /** Update document status and optional fields. */
  updateDocument(
    documentId: string,
    update: {
      status: DocumentStatus;
      storageKey?: string;
      byteSize?: number;
      generatedAt?: Date;
    },
  ): Promise<void>;
  /** Fetch a single document by id, itinerary and user (ownership enforced). */
  findDocument(
    documentId: string,
    itineraryId: string,
    userId: string,
  ): Promise<TripDocumentRow | null>;
  /** Audit tx client for append-only audit rows. */
  auditTxClient: AuditTxClient;
}

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface TripDocumentLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// TripDocumentService
// ---------------------------------------------------------------------------

export class TripDocumentService {
  constructor(
    private readonly repo: TripDocumentRepositoryPort,
    private readonly pdfRenderer: PdfRendererPort,
    private readonly storage: DocumentStoragePort,
    private readonly securityWriter: SecurityEventWriter,
    private readonly log: TripDocumentLogger,
    private readonly clock: () => Date = () => new Date(),
    private readonly documentRetentionDays: number = 90,
  ) {}

  // ── generateDocument ────────────────────────────────────────────────────

  /**
   * Generate a trip document PDF for the caller's itinerary.
   *
   * Preconditions checked before rendering:
   *   1. Itinerary exists (→ 404)
   *   2. Itinerary is owned by caller (→ 403 + security audit)
   *   3. At least one booking is CONFIRMED (→ 409)
   *   4. Booking count ≤ MAX_BOOKINGS_PER_DOCUMENT
   *
   * @returns DocumentResponse with status READY and downloadUrl on success,
   *          or FAILED on rendering/storage error (never throws internally).
   */
  async generateDocument(
    itineraryId: string,
    userId: string,
    actor: { id: string; role: string },
    correlationId: string,
    locale: string = "en",
  ): Promise<DocumentResponse> {
    // ── Precondition 1/2: existence + ownership (404-vs-403) ──────────────
    const bare = await this.repo.findItineraryById(itineraryId);
    if (!bare) {
      throw notFound("Itinerary not found");
    }

    if (bare.userId !== userId) {
      await this.securityWriter.write({
        actorId: actor.id,
        actorRole: actor.role,
        resourceType: "itinerary",
        resourceId: itineraryId,
        operation: "GENERATE_DOCUMENT",
        decision: "DENY",
        reason: "OWNERSHIP_PREDICATE_FAILED",
      });
      throw forbidden("Access denied to itinerary");
    }

    // ── Fetch full itinerary (ownership-scoped query) ─────────────────────
    const itinerary = await this.repo.findItineraryForDocument(itineraryId, userId);
    if (!itinerary) {
      throw notFound("Itinerary not found");
    }

    // ── Precondition 3: at least one CONFIRMED booking ────────────────────
    const confirmedCount = itinerary.bookings.filter(
      (b) => b.status === "CONFIRMED",
    ).length;
    if (confirmedCount === 0) {
      throw conflict(
        "Cannot generate a trip document: itinerary has no CONFIRMED bookings. " +
          "All bookings must reach CONFIRMED status before a document can be issued.",
        "itineraryId",
      );
    }

    // ── Precondition 4: booking count cap ─────────────────────────────────
    if (itinerary.bookings.length > MAX_BOOKINGS_PER_DOCUMENT) {
      throw conflict(
        `Itinerary has ${itinerary.bookings.length} bookings; maximum per document is ${MAX_BOOKINGS_PER_DOCUMENT}.`,
        "itineraryId",
      );
    }

    // ── Persist document row in PENDING ───────────────────────────────────
    const purgeAfter = new Date(this.clock());
    purgeAfter.setDate(purgeAfter.getDate() + this.documentRetentionDays);

    const docRow = await this.repo.createDocument(
      itineraryId,
      userId,
      correlationId,
      purgeAfter,
    );

    // ── Audit: generation attempt ──────────────────────────────────────────
    await writeAudit({
      tx: this.repo.auditTxClient,
      bookingId: itineraryId,
      action: "DOCUMENT_GENERATION_STARTED",
      actorId: actor.id,
      actorRole: actor.role,
      resourceType: "trip_document",
      resourceId: docRow.id,
      occurredAt: this.clock(),
      payload: { itineraryId, documentId: docRow.id, correlationId },
    });

    // ── Project to allow-listed view model ────────────────────────────────
    const generatedAt = this.clock();
    const viewModel = projectToTripDocument(
      this._toItineraryDocumentInput(itinerary),
      docRow.id,
      generatedAt.toISOString(),
      locale,
    );

    // ── Render + store (with error capture) ───────────────────────────────
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await this.pdfRenderer.render(viewModel);
    } catch (err) {
      await this._markFailed(docRow.id, err, actor, itineraryId, correlationId, "RENDER_FAILED");
      throw this._wrapGenerationError(docRow.id, "PDF rendering failed", err);
    }

    if (pdfBuffer.byteLength > MAX_DOCUMENT_BYTES) {
      await this._markFailed(docRow.id, null, actor, itineraryId, correlationId, "DOCUMENT_TOO_LARGE");
      throw this._wrapGenerationError(docRow.id, `Generated PDF exceeds size limit (${MAX_DOCUMENT_BYTES} bytes)`);
    }

    const storageKey = `${userId}/${itineraryId}/${docRow.id}.pdf`;
    try {
      await this.storage.store(storageKey, pdfBuffer);
    } catch (err) {
      await this._markFailed(docRow.id, err, actor, itineraryId, correlationId, "STORAGE_FAILED");
      throw this._wrapGenerationError(docRow.id, "Document storage failed", err);
    }

    // ── Mark READY ────────────────────────────────────────────────────────
    await this.repo.updateDocument(docRow.id, {
      status: "READY",
      storageKey,
      byteSize: pdfBuffer.byteLength,
      generatedAt,
    });

    // ── Issue signed URL (never log) ──────────────────────────────────────
    let downloadUrl: string;
    try {
      downloadUrl = await this.storage.issueSignedUrl(storageKey, SIGNED_URL_EXPIRY_SECONDS);
    } catch (err) {
      await this._markFailed(docRow.id, err, actor, itineraryId, correlationId, "SIGN_FAILED");
      throw this._wrapGenerationError(docRow.id, "Failed to issue download URL", err);
    }

    const expiresAt = new Date(generatedAt.getTime() + SIGNED_URL_EXPIRY_SECONDS * 1000);

    // ── Audit: generation success ──────────────────────────────────────────
    await writeAudit({
      tx: this.repo.auditTxClient,
      bookingId: itineraryId,
      action: "DOCUMENT_GENERATION_COMPLETED",
      actorId: actor.id,
      actorRole: actor.role,
      resourceType: "trip_document",
      resourceId: docRow.id,
      occurredAt: this.clock(),
      payload: {
        itineraryId,
        documentId: docRow.id,
        byteSize: pdfBuffer.byteLength,
        correlationId,
        // downloadUrl is NEVER included in audit records (AC7)
      },
    });

    this.log.info(
      {
        itineraryId,
        documentId: docRow.id,
        byteSize: pdfBuffer.byteLength,
        correlationId,
        // downloadUrl intentionally omitted from logs (AC7)
      },
      "Trip document generated successfully",
    );

    return {
      documentId: docRow.id,
      status: "READY",
      downloadUrl, // present; caller must not log this value
      expiresAt: expiresAt.toISOString(),
      generatedAt: generatedAt.toISOString(),
    };
  }

  // ── getDocument ──────────────────────────────────────────────────────────

  /**
   * Return the current status and a fresh signed URL for an existing document.
   * Ownership is enforced by the query predicate (userId in WHERE clause).
   */
  async getDocument(
    itineraryId: string,
    documentId: string,
    userId: string,
    actor: { id: string; role: string },
    correlationId: string,
  ): Promise<DocumentResponse> {
    const bare = await this.repo.findItineraryById(itineraryId);
    if (!bare) throw notFound("Itinerary not found");

    if (bare.userId !== userId) {
      await this.securityWriter.write({
        actorId: actor.id,
        actorRole: actor.role,
        resourceType: "trip_document",
        resourceId: documentId,
        operation: "GET_DOCUMENT",
        decision: "DENY",
        reason: "OWNERSHIP_PREDICATE_FAILED",
      });
      throw forbidden("Access denied to itinerary");
    }

    const docRow = await this.repo.findDocument(documentId, itineraryId, userId);
    if (!docRow) throw notFound("Document not found");

    const response: DocumentResponse = {
      documentId: docRow.id,
      status: docRow.status,
      ...(docRow.generatedAt ? { generatedAt: docRow.generatedAt.toISOString() } : {}),
    };

    if (docRow.status === "READY" && docRow.storageKey) {
      const downloadUrl = await this.storage.issueSignedUrl(
        docRow.storageKey,
        SIGNED_URL_EXPIRY_SECONDS,
      );
      const expiresAt = new Date(Date.now() + SIGNED_URL_EXPIRY_SECONDS * 1000);
      return {
        ...response,
        downloadUrl, // never log this value
        expiresAt: expiresAt.toISOString(),
      };
    }

    return response;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _toItineraryDocumentInput(row: ItineraryDocumentRow): ItineraryDocumentInput {
    const bookings = row.bookings.map((b) => ({
      id: b.id,
      bookingType: b.bookingType,
      status: b.status,
      supplier: b.supplier ?? undefined,
      confirmationReference: b.confirmationReference ?? undefined,
      travelStartDate: b.travelStartDate?.toISOString() ?? undefined,
      travelEndDate: b.travelEndDate?.toISOString() ?? undefined,
      origin: b.origin ?? undefined,
      destination: b.destination ?? undefined,
      totalPrice: b.totalPrice.toString(),
      currency: b.currency,
      travellers: b.travellers,
    }));

    // Per-currency totals (integer arithmetic — no floating point)
    const totalsMap = new Map<string, bigint>();
    for (const b of row.bookings) {
      const price = b.totalPrice.toString();
      const cents = this._priceToCents(price);
      totalsMap.set(b.currency, (totalsMap.get(b.currency) ?? 0n) + cents);
    }
    const totals = [...totalsMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, cents]) => ({ currency, amount: this._centsToPrice(cents) }));

    return {
      id: row.id,
      name: row.name,
      startDate: row.startDate?.toISOString() ?? new Date(0).toISOString(),
      endDate: row.endDate?.toISOString() ?? new Date(0).toISOString(),
      bookings,
      totals,
    };
  }

  private _priceToCents(price: string): bigint {
    const clean = price.trim();
    const dotIdx = clean.indexOf(".");
    if (dotIdx === -1) return BigInt(clean) * 100n;
    const whole = clean.slice(0, dotIdx);
    const frac = clean.slice(dotIdx + 1).padEnd(2, "0").slice(0, 2);
    return BigInt(whole) * 100n + BigInt(frac);
  }

  private _centsToPrice(cents: bigint): string {
    const dollars = cents / 100n;
    const centsPart = cents % 100n;
    return `${dollars}.${centsPart.toString().padStart(2, "0")}`;
  }

  private async _markFailed(
    documentId: string,
    cause: unknown,
    actor: { id: string; role: string },
    itineraryId: string,
    correlationId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.repo.updateDocument(documentId, { status: "FAILED" });
    } catch (_updateErr) {
      // Best-effort — do not shadow the original error
    }
    this.log.error(
      {
        documentId,
        itineraryId,
        correlationId,
        actorId: actor.id,
        actorRole: actor.role,
        reason,
        err: cause instanceof Error ? cause.message : String(cause),
      },
      "Trip document generation failed",
    );
    try {
      await writeAudit({
        tx: this.repo.auditTxClient,
        bookingId: itineraryId,
        action: "DOCUMENT_GENERATION_FAILED",
        actorId: actor.id,
        actorRole: actor.role,
        resourceType: "trip_document",
        resourceId: documentId,
        occurredAt: this.clock(),
        payload: { itineraryId, documentId, correlationId, reason },
      });
    } catch (_auditErr) {
      // Audit failure is logged but not re-thrown
      this.log.error({ documentId, correlationId }, "Failed to write audit row for document failure");
    }
  }

  private _wrapGenerationError(documentId: string, message: string, cause?: unknown): Error {
    const err = new DocumentGenerationError(documentId, message, cause);
    return err;
  }
}

// ---------------------------------------------------------------------------
// DocumentGenerationError — retryable error returned to the caller (AC8)
// ---------------------------------------------------------------------------

export class DocumentGenerationError extends Error {
  constructor(
    readonly documentId: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DocumentGenerationError";
  }
}
