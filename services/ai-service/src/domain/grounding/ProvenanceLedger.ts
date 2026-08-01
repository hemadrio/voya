/**
 * ProvenanceLedger — per-turn record of every offer returned by first-party
 * tools (WO-060).
 *
 * Populated by the orchestrator on every successful tool dispatch.  All offer
 * cards emitted to the client must trace back to a ledger entry — card fields
 * are copied from here, never from model prose.
 *
 * Thread safety: one ledger per turn, never shared.
 */

// ---------------------------------------------------------------------------
// Offer snapshot — normalised representation stored in the ledger
// ---------------------------------------------------------------------------

export interface OfferSnapshot {
  /** Unique offer identifier (the "id" field on the raw tool result). */
  offerRef: string;
  /** Registered tool name that produced this offer. */
  tool: string;
  /** Upstream supplier/provenance string (e.g. "AMADEUS", "RAPIDAPI_HOTEL"). */
  supplier: string;
  /** Epoch milliseconds when the tool result arrived. */
  retrievedAt: number;
  /** Price as a number (for exact comparison). */
  price: number;
  /** ISO 4217 currency code, upper-cased. */
  currency: string;
  /** Normalised route string "ORIG-DEST" for flight offers. */
  route?: string;
  /** Property name for hotel/car offers. */
  property?: string;
  /** Whether the offer is bookable per the tool result. */
  availability: boolean;
  /** Raw display title from the tool result. */
  displayTitle?: string;
  /** Raw display summary / subtitle from the tool result. */
  displaySummary?: string;
}

// ---------------------------------------------------------------------------
// Raw offer shape extracted from tool results
// ---------------------------------------------------------------------------

interface RawOffer {
  id?: unknown;
  provenance?: unknown;
  supplier?: unknown;
  price?: unknown;
  currency?: unknown;
  bookable?: unknown;
  available?: unknown;
  title?: unknown;
  description?: unknown;
  summary?: unknown;
  route?: unknown;
  property?: unknown;
  from?: unknown;
  to?: unknown;
  origin?: unknown;
  destination?: unknown;
}

// ---------------------------------------------------------------------------
// ProvenanceLedger
// ---------------------------------------------------------------------------

export class ProvenanceLedger {
  private readonly entries = new Map<string, OfferSnapshot>();

  /**
   * Extract and record offers from a raw tool result.
   *
   * Handles both array-of-offers and single-offer responses.
   * Silently skips entries that cannot be normalised (parser bug → fail safe).
   */
  record(toolName: string, toolResult: unknown, retrievedAt: number): void {
    const offers: RawOffer[] = Array.isArray(toolResult)
      ? (toolResult as RawOffer[])
      : [toolResult as RawOffer];

    for (const raw of offers) {
      try {
        const snapshot = normalise(raw, toolName, retrievedAt);
        if (snapshot !== null) {
          this.entries.set(snapshot.offerRef, snapshot);
        }
      } catch {
        // Normalisation failure → skip this entry; don't disrupt the turn
      }
    }
  }

  /**
   * Look up a ledger entry by offer reference.
   * Returns undefined for unknown references — callers must treat as unsupported.
   */
  get(offerRef: string): OfferSnapshot | undefined {
    return this.entries.get(offerRef);
  }

  /** Return all recorded snapshots (stable insertion order). */
  getAll(): OfferSnapshot[] {
    return Array.from(this.entries.values());
  }

  get size(): number {
    return this.entries.size;
  }

  /** True when no offers have been recorded (e.g. tool returned zero results). */
  get isEmpty(): boolean {
    return this.entries.size === 0;
  }
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function normalise(raw: RawOffer, toolName: string, retrievedAt: number): OfferSnapshot | null {
  const id = String(raw.id ?? "");
  if (!id) return null;

  const price = toNumber(raw.price);
  if (price === null) return null;

  const currency = toUpperStr(raw.currency ?? "USD");
  const supplier = toUpperStr(raw.provenance ?? raw.supplier ?? "UNKNOWN");
  const availability = toBool(raw.bookable ?? raw.available ?? false);
  const displayTitle = toStr(raw.title);
  const displaySummary = toStr(raw.description ?? raw.summary);

  // Route: prefer explicit "route" field, else build from from/to or origin/dest
  let route: string | undefined;
  if (raw.route) {
    route = normaliseRoute(String(raw.route));
  } else {
    const orig = toStr(raw.from ?? raw.origin);
    const dest = toStr(raw.to ?? raw.destination);
    if (orig && dest) route = normaliseRoute(`${orig}-${dest}`);
  }

  // Property name for hotels/cars
  const property = toStr(raw.property ?? (toolName !== "search_flights" ? raw.title : undefined));

  return {
    offerRef: id,
    tool: toolName,
    supplier,
    retrievedAt,
    price,
    currency,
    route,
    property: toolName === "search_flights" ? undefined : property,
    availability,
    displayTitle,
    displaySummary,
  };
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^0-9.]/g, ""));
    return isFinite(n) ? n : null;
  }
  return null;
}

function toUpperStr(v: unknown): string {
  return String(v).toUpperCase();
}

function toStr(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v);
  return s.length > 0 ? s : undefined;
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return Boolean(v);
}

/** Normalise a route string to "ORIG-DEST" (upper-case IATA codes). */
export function normaliseRoute(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\s*(→|->|TO|➔)\s*/gi, "-")
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9-]/g, "");
}
