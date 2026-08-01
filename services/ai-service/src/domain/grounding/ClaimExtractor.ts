/**
 * ClaimExtractor — deterministic parser extracting factual travel claims from
 * assistant text (WO-060).
 *
 * Recognises four claim types using regex-based parsing (no model call):
 *   PRICE        — currency amounts: $412.50, 412 USD, €189, 189 EUR
 *   ROUTE        — airport/city pairs: JFK to CDG, LHR → JFK, JFK-CDG
 *   TIME         — departure/arrival times: 10:30 AM, 14:45, 07:00
 *   AVAILABILITY — assertive availability language: "available", "confirmed"
 *
 * Returns an array of Claim objects with text spans, allowing the assembler to
 * perform surgical replacement without reparsing.
 *
 * Parsing is deterministic: same input always produces the same output.
 * Extraction failures (bad regex match) are skipped — fail safe.
 */

// ---------------------------------------------------------------------------
// Claim types
// ---------------------------------------------------------------------------

export type ClaimType = "PRICE" | "ROUTE" | "TIME" | "AVAILABILITY";

export interface TextSpan {
  start: number;
  end: number;
}

export interface Claim {
  type: ClaimType;
  span: TextSpan;
  /** The exact substring from the original text. */
  rawText: string;
  /**
   * Normalised value used for matching:
   * - PRICE: "<amount>:<currency>" e.g. "412.50:USD"
   * - ROUTE: "ORIG-DEST" e.g. "JFK-CDG"
   * - TIME: "HH:MM" in 24h format
   * - AVAILABILITY: lowercase keyword
   */
  normalisedValue: string;
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// PRICE: $412.50 | USD 412.50 | 412.50 USD | €189 | 189 EUR | £50
// Groups: [sign][amount][currency] or [currency][amount]
const CURRENCY_SYMBOLS: Record<string, string> = {
  "$": "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "¢": "USD",
};

const PRICE_REGEX =
  /(?:(USD|EUR|GBP|CAD|AUD|JPY|CHF|SEK|NOK|DKK)\s*(\d{1,6}(?:[.,]\d{1,2})?)|(\d{1,6}(?:[.,]\d{1,2})?)\s*(USD|EUR|GBP|CAD|AUD|JPY|CHF|SEK|NOK|DKK)|([$€£¥])\s*(\d{1,6}(?:[.,]\d{1,2})?))/gi;

// ROUTE: JFK to CDG | JFK → CDG | JFK - CDG | JFK-CDG
// Three-letter IATA codes (upper/lower) with separators
const ROUTE_REGEX =
  /\b([A-Z]{3})\s*(?:to|→|->|–|-)\s*([A-Z]{3})\b/gi;

// TIME: 10:30 AM | 14:45 | 7:00am | 23:59
const TIME_REGEX =
  /\b(\d{1,2}):(\d{2})(?:\s*(AM|PM))?\b/gi;

// AVAILABILITY: assertive presence language
const AVAILABILITY_KEYWORDS = [
  "available",
  "confirmed",
  "in stock",
  "seats available",
  "rooms available",
  "currently available",
  "still available",
  "booking available",
  "can book",
  "you can book",
  "ready to book",
  "open for booking",
];
const AVAILABILITY_REGEX = new RegExp(
  `\\b(${AVAILABILITY_KEYWORDS.map(escapeRegex).join("|")})\\b`,
  "gi",
);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// ClaimExtractor
// ---------------------------------------------------------------------------

export class ClaimExtractor {
  /**
   * Extract all factual travel claims from the given text.
   * Claims are returned in document order (ascending start offset).
   */
  extract(text: string): Claim[] {
    const claims: Claim[] = [];

    this.extractPrices(text, claims);
    this.extractRoutes(text, claims);
    this.extractTimes(text, claims);
    this.extractAvailability(text, claims);

    // Sort by start position for deterministic, document-ordered output
    claims.sort((a, b) => a.span.start - b.span.start);

    // Deduplicate overlapping spans (keep whichever claim starts first)
    return deduplicateBySpan(claims);
  }

  // ---------------------------------------------------------------------------
  // Private extractors
  // ---------------------------------------------------------------------------

  private extractPrices(text: string, out: Claim[]): void {
    PRICE_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = PRICE_REGEX.exec(text)) !== null) {
      try {
        const full = match[0];
        let amount: number;
        let currency: string;

        if (match[1] && match[2]) {
          // "USD 412.50"
          currency = match[1].toUpperCase();
          amount = parseLocaleFloat(match[2]);
        } else if (match[3] && match[4]) {
          // "412.50 USD"
          amount = parseLocaleFloat(match[3]);
          currency = match[4].toUpperCase();
        } else if (match[5] && match[6]) {
          // "$412.50"
          currency = CURRENCY_SYMBOLS[match[5]] ?? "USD";
          amount = parseLocaleFloat(match[6]);
        } else {
          continue;
        }

        if (!isFinite(amount) || amount <= 0) continue;

        out.push({
          type: "PRICE",
          span: { start: match.index, end: match.index + full.length },
          rawText: full,
          normalisedValue: `${amount.toFixed(2)}:${currency}`,
        });
      } catch {
        // Skip malformed match — fail safe
      }
    }
  }

  private extractRoutes(text: string, out: Claim[]): void {
    ROUTE_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = ROUTE_REGEX.exec(text)) !== null) {
      const orig = match[1].toUpperCase();
      const dest = match[2].toUpperCase();
      // Skip false positives (same code repeated)
      if (orig === dest) continue;

      out.push({
        type: "ROUTE",
        span: { start: match.index, end: match.index + match[0].length },
        rawText: match[0],
        normalisedValue: `${orig}-${dest}`,
      });
    }
  }

  private extractTimes(text: string, out: Claim[]): void {
    TIME_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = TIME_REGEX.exec(text)) !== null) {
      let hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      const meridiem = match[3]?.toUpperCase();

      if (meridiem === "PM" && hours < 12) hours += 12;
      if (meridiem === "AM" && hours === 12) hours = 0;

      if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) continue;

      out.push({
        type: "TIME",
        span: { start: match.index, end: match.index + match[0].length },
        rawText: match[0],
        normalisedValue: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
      });
    }
  }

  private extractAvailability(text: string, out: Claim[]): void {
    AVAILABILITY_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = AVAILABILITY_REGEX.exec(text)) !== null) {
      out.push({
        type: "AVAILABILITY",
        span: { start: match.index, end: match.index + match[0].length },
        rawText: match[0],
        normalisedValue: match[0].toLowerCase(),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLocaleFloat(s: string): number {
  // Handle comma as thousands separator (1,234.50 → 1234.50)
  return parseFloat(s.replace(/,/g, ""));
}

function deduplicateBySpan(claims: Claim[]): Claim[] {
  const result: Claim[] = [];
  for (const claim of claims) {
    const overlaps = result.some(
      (c) => c.span.start < claim.span.end && c.span.end > claim.span.start,
    );
    if (!overlaps) result.push(claim);
  }
  return result;
}
