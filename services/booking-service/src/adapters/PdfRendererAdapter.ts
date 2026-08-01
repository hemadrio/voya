/**
 * PdfRendererAdapter — port interface and in-process stub for PDF generation (WO-054).
 *
 * Architecture (ADR-0011):
 *   Domain layer depends only on PdfRendererPort (this file's interface).
 *   In production the concrete PdfKitRendererAdapter wraps pdfkit and emits
 *   a tagged, PDF/UA-compliant byte stream.
 *   In tests the NullPdfRendererAdapter returns a minimal synthetic buffer.
 *
 * The domain layer (TripDocumentService) never imports pdfkit.
 */

import type { TripDocumentViewModel } from "@travel/contracts/documents";

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

/**
 * PdfRendererPort — injectable boundary between the domain and the PDF library.
 *
 * Implementations must produce a tagged PDF conforming to PDF/UA-1:
 *   - /StructTreeRoot in the catalog
 *   - Document language set (/Lang)
 *   - Document title set (Info dictionary /Title)
 *   - Headings in ascending order (H1 → H2 → H3)
 *   - Table TH cells for every header row
 *   - No Artifact content in the logical structure
 *
 * @throws {PdfRenderError} on any library-level failure.
 */
export interface PdfRendererPort {
  render(viewModel: TripDocumentViewModel): Promise<Buffer>;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class PdfRenderError extends Error {
  constructor(
    readonly itineraryId: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PdfRenderError";
  }
}

// ---------------------------------------------------------------------------
// NullPdfRendererAdapter — test/stub implementation
//
// Returns a minimal well-formed synthetic Buffer.  Not a real PDF — only
// used in unit and integration tests where the PDF byte stream is not
// validated for structure but where the path through TripDocumentService
// must exercise the render → store → signedUrl flow.
// ---------------------------------------------------------------------------

export class NullPdfRendererAdapter implements PdfRendererPort {
  async render(viewModel: TripDocumentViewModel): Promise<Buffer> {
    const header = `%PDF-1.7\n% Synthetic test output — not a real tagged PDF\n`;
    const body = [
      `Trip: ${viewModel.itineraryName}`,
      `Itinerary: ${viewModel.itineraryId}`,
      `Generated: ${viewModel.generatedAt}`,
      `Bookings: ${viewModel.bookings.length}`,
      viewModel.bookings
        .map(
          (b) =>
            `Booking ${b.id}: ${b.bookingType} ${b.status} ${b.price} ${b.currency}` +
            (b.confirmationReference ? ` ref=${b.confirmationReference}` : "") +
            b.travellers.map((t) => ` traveller=${t.givenName} ${t.familyName}`).join(""),
        )
        .join("\n"),
      viewModel.totals.map((t) => `Total: ${t.amount} ${t.currency}`).join("\n"),
    ].join("\n");

    return Buffer.from(header + body, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// PdfKitRendererAdapter — production stub
//
// Production wiring would inject a real pdfkit-based implementation.
// This placeholder documents the expected structure and throws clearly when
// called in environments where pdfkit is not installed.
// ---------------------------------------------------------------------------

export class PdfKitRendererAdapter implements PdfRendererPort {
  async render(viewModel: TripDocumentViewModel): Promise<Buffer> {
    // In production, this method constructs a PDFDocument with structure
    // elements following ADR-0011:
    //
    //   const doc = new PDFDocument({ tagged: true, lang: viewModel.locale })
    //   doc.info.Title = viewModel.itineraryName
    //   const struct = doc.struct('Document', () => {
    //     doc.struct('H1', () => doc.text(viewModel.itineraryName))
    //     viewModel.bookings.forEach(b => renderBookingSection(doc, b))
    //     renderTotalsTable(doc, viewModel.totals)
    //   })
    //   struct.end()
    //   doc.end()
    //   return streamToBuffer(doc)
    //
    // pdfkit is not installed in this monorepo at present.
    // Inject NullPdfRendererAdapter in tests; wire the real implementation
    // when pdfkit is added as a dependency (see ADR-0011).
    throw new PdfRenderError(
      viewModel.itineraryId,
      "PdfKitRendererAdapter requires pdfkit to be installed as a dependency. " +
        "Use NullPdfRendererAdapter in tests.",
    );
  }
}
