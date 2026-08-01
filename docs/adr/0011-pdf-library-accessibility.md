# ADR-0011 — PDF Library Selection for Trip Document Generation

**Status:** Accepted  
**Date:** 2026-08-01  
**Story:** WO-054 — Render accessible trip document PDF excluding identity data

---

## Context

WO-054 requires the booking service to generate trip documents as PDF files that satisfy WCAG 2.2 AA and PDF/UA-1 (ISO 14289-1). The critical non-functional requirement is **tagged PDF output**: the rendered file must contain a document structure tree, ordered headings, table header cells, alt text on images, and document language and title metadata. An untagged PDF fails the story regardless of visual quality.

Two paths were evaluated:

| Path | Libraries considered |
|------|---------------------|
| Native PDF construction | `pdfkit` (PDF/A support via `pdfkit-build`), `pdf-lib` |
| HTML-to-PDF | `puppeteer` / Chromium headless, `playwright` |

---

## Decision

**Selected: `pdfkit` (with `pdfkit-pdf-ua` or equivalent tagged-output plugin)** implemented behind an injectable `PdfRendererPort` interface.

### How tagged structure is produced

`pdfkit` exposes low-level PDF primitives that allow explicit construction of the logical structure tree required for PDF/UA:

- `doc.markContent('Document')` / `doc.struct('Document', ...)` — root structure element
- `doc.struct('H1', ...)`, `doc.struct('H2', ...)` — heading levels in document order
- `doc.struct('P', ...)` — paragraphs; every text span wrapped in a structure element
- `doc.struct('Table', () => [ TH(), TD(), ... ])` — table with explicit `TH` cells for header rows
- `doc.info.Title`, `doc.info.Lang` — document metadata (title and language)
- `doc.markContent('Artifact')` — background decorations excluded from the reading order

The output satisfies:
- ISO 32000-1 §14.7 (Logical Structure)
- ISO 14289-1 §7.1 (Document title), §7.2 (Language), §7.3 (Structure tree)
- WCAG 2.2 AA success criteria 1.3.1 (Info and Relationships) and 1.3.2 (Meaningful Sequence)

### Why not Puppeteer/Playwright

Headless Chromium produces PDF/UA-compliant output **only** when the source HTML includes the full WAI-ARIA attribute set and the Chromium build supports `tagged-pdf` mode (available from Chrome 112+). Chromium embeds an ~150 MB binary, making the ECS image significantly larger, and its tagged-PDF path is not validated by the toolchain in CI. Accepting a heavy binary dependency for uncertain accessibility compliance was rejected.

### Why not `pdf-lib`

`pdf-lib` is an excellent manipulation library but provides no native structure-tree construction API. Producing a tagged PDF with `pdf-lib` requires manually encoding low-level stream operators, which is error-prone and untestable at the element level.

---

## Architecture

The renderer is **isolated behind an injectable port**:

```
TripDocumentService
  └── PdfRendererPort  ← interface (domain layer, no library import)
        └── PdfKitRendererAdapter  ← concrete, library-specific (adapters/)
```

- The domain layer (`TripDocumentService`, `tripDocumentProjection`) imports only the port interface.
- The concrete `PdfKitRendererAdapter` is the only file that imports `pdfkit`.
- Test doubles implement `PdfRendererPort` and return a synthetic `Buffer`; no pdfkit installation required in tests.

---

## Accessibility CI gate

A tagged-PDF validator runs as a CI step using `pdfjs-dist` or the `pdf-accessibility-checker` npm package:

```
pnpm run test:pdf-a11y -- fixtures/trip-document-golden.pdf
```

Assertions:
1. Structure tree root element exists (`/StructTreeRoot` dictionary present)
2. Document language set (`/Lang` key in the document catalog)
3. Document title set (`/Title` in the `Info` dictionary)
4. All heading structure elements appear in ascending order (`H1`, `H2`, `H3` — no skip)
5. Table `TH` elements exist for every header row
6. No `Figure` structure element missing an `Alt` attribute

The CI step uses the golden fixture committed at `services/booking-service/test/fixtures/trip-document-golden.pdf`. The fixture is regenerated only when the view model schema or rendering logic changes.

---

## Alternatives rejected

| Option | Rejection reason |
|--------|-----------------|
| `html-pdf` (wkhtmltopdf) | Produces no structure tree; accessibility CI would always fail |
| `react-pdf` | Tagged-PDF support is experimental; no `TH` element support in the current release |
| Inline SVG-to-PDF | No standard path to a compliant structure tree |
