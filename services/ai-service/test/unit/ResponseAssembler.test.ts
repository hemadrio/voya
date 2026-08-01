/**
 * ResponseAssembler unit tests (WO-060).
 *
 * Tests: unsupported claim stripping, grounded offer card construction,
 * fabricated offer rejection, stale offer marking, fallback message,
 * and golden-file idempotency.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ResponseAssembler, GROUNDING_FALLBACK_MESSAGE } from "../../src/domain/grounding/ResponseAssembler.js";
import { ClaimExtractor } from "../../src/domain/grounding/ClaimExtractor.js";
import { GroundingVerifier } from "../../src/domain/grounding/GroundingVerifier.js";
import {
  makeFlightLedger,
  makeStaleLedger,
  makeHotelLedger,
  makeEmptyLedger,
  NOW_MS,
  FRESHNESS_MS,
  GROUNDED_MODEL_OUTPUT,
  NEAR_MISS_PRICE_MODEL_OUTPUT,
  FABRICATED_OFFER_MODEL_OUTPUT,
  NO_CLAIMS_MODEL_OUTPUT,
  HOTEL_GROUNDED_MODEL_OUTPUT,
  CURRENCY_MISMATCH_MODEL_OUTPUT,
} from "../fixtures/grounding-fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const claimExtractor = new ClaimExtractor();

function assemble(text: string, ledger: ReturnType<typeof makeFlightLedger>, now = NOW_MS) {
  const verifier = new GroundingVerifier(FRESHNESS_MS, () => now);
  const assembler = new ResponseAssembler(FRESHNESS_MS);
  const claims = claimExtractor.extract(text);
  const verdicts = verifier.verify(claims, ledger);
  return assembler.assemble(text, verdicts, ledger, now);
}

// ---------------------------------------------------------------------------
// Offer card construction
// ---------------------------------------------------------------------------

describe("ResponseAssembler — offer card sourcing", () => {
  it("builds offer cards exclusively from ledger snapshots (not model text)", () => {
    const result = assemble(GROUNDED_MODEL_OUTPUT, makeFlightLedger());
    expect(result.offerCards.length).toBeGreaterThan(0);
    for (const card of result.offerCards) {
      expect(card.offerRef).toBeTruthy();
      expect(card.supplier).toBeTruthy();
      expect(card.price).toBeTypeOf("number");
      expect(card.currency).toBeTruthy();
    }
  });

  it("offer card fields match the ledger snapshot exactly", () => {
    const ledger = makeFlightLedger();
    const result = assemble(GROUNDED_MODEL_OUTPUT, ledger);
    const card = result.offerCards.find((c) => c.offerRef === "flight-001");
    expect(card).toBeDefined();
    expect(card!.price).toBe(412.5);
    expect(card!.currency).toBe("USD");
    expect(card!.supplier).toBe("AMADEUS");
    expect(card!.tool).toBe("search_flights");
    expect(card!.retrievedAt).toBe(NOW_MS);
    expect(card!.stale).toBe(false);
  });

  it("does NOT emit a card for a fabricated offer reference in model text", () => {
    // Model text mentions $199 JFK-CDG but ledger has LHR-JFK $412.50
    const result = assemble(FABRICATED_OFFER_MODEL_OUTPUT, makeFlightLedger());
    // No card should have offerRef "flight-003" or any price=199
    expect(result.offerCards.every((c) => c.price !== 199)).toBe(true);
    expect(result.offerCards.every((c) => c.offerRef !== "fabricated-offer")).toBe(true);
  });

  it("marks stale offer card when retrieval is past freshness window", () => {
    const result = assemble(GROUNDED_MODEL_OUTPUT, makeStaleLedger());
    const card = result.offerCards.find((c) => c.offerRef === "flight-001");
    expect(card?.stale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Claim stripping / rewriting
// ---------------------------------------------------------------------------

describe("ResponseAssembler — claim stripping", () => {
  it("removes near-miss price (off by one cent) from safe text", () => {
    const result = assemble(NEAR_MISS_PRICE_MODEL_OUTPUT, makeFlightLedger());
    expect(result.safeText).not.toContain("$412.51");
    expect(result.strippedClaims.some((c) => c.type === "PRICE")).toBe(true);
  });

  it("removes currency mismatch price from safe text", () => {
    // Model says $189 USD but ledger has €189 EUR
    const result = assemble(CURRENCY_MISMATCH_MODEL_OUTPUT, makeHotelLedger());
    expect(result.safeText).not.toContain("$189 USD");
    expect(result.strippedClaims.some((c) => c.type === "PRICE")).toBe(true);
  });

  it("preserves text when no factual claims exist", () => {
    const result = assemble(NO_CLAIMS_MODEL_OUTPUT, makeFlightLedger());
    expect(result.safeText).toBe(NO_CLAIMS_MODEL_OUTPUT);
    expect(result.strippedClaims).toHaveLength(0);
    expect(result.usedFallback).toBe(false);
  });

  it("passes through text unchanged when all claims are grounded", () => {
    const result = assemble(GROUNDED_MODEL_OUTPUT, makeFlightLedger());
    // Price and route claims should be grounded — no PRICE or ROUTE stripped
    const priceClaims = result.strippedClaims.filter((c) => c.type === "PRICE");
    const routeClaims = result.strippedClaims.filter((c) => c.type === "ROUTE");
    expect(priceClaims).toHaveLength(0);
    expect(routeClaims).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fallback message
// ---------------------------------------------------------------------------

describe("ResponseAssembler — fallback message", () => {
  it("emits fallback when all claims in the turn are unsupported and no offer cards", () => {
    // Fabricated output with claims that won't match the empty ledger
    const result = assemble(FABRICATED_OFFER_MODEL_OUTPUT, makeEmptyLedger());
    expect(result.usedFallback).toBe(true);
    expect(result.safeText).toBe(GROUNDING_FALLBACK_MESSAGE);
  });

  it("fallback message is non-empty and user-facing", () => {
    expect(GROUNDING_FALLBACK_MESSAGE.length).toBeGreaterThan(20);
    expect(GROUNDING_FALLBACK_MESSAGE).not.toContain("error");
  });
});

// ---------------------------------------------------------------------------
// Grounding references
// ---------------------------------------------------------------------------

describe("ResponseAssembler — groundingRefs", () => {
  it("includes a groundingRef for each matched offer", () => {
    const result = assemble(GROUNDED_MODEL_OUTPUT, makeFlightLedger());
    expect(result.groundingRefs.length).toBeGreaterThan(0);
    for (const ref of result.groundingRefs) {
      expect(ref.offerRef).toBeTruthy();
      expect(ref.tool).toBe("search_flights");
      expect(ref.price).toBeTypeOf("number");
      expect(ref.currency).toBeTruthy();
    }
  });

  it("returns empty groundingRefs when ledger is empty", () => {
    const result = assemble(NO_CLAIMS_MODEL_OUTPUT, makeEmptyLedger());
    expect(result.groundingRefs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Golden-file idempotency
// ---------------------------------------------------------------------------

describe("ResponseAssembler — determinism/idempotency", () => {
  it("produces identical output on repeated calls with same input", () => {
    const ledger = makeFlightLedger();
    const r1 = assemble(GROUNDED_MODEL_OUTPUT, ledger);
    const r2 = assemble(GROUNDED_MODEL_OUTPUT, ledger);
    expect(r1.safeText).toBe(r2.safeText);
    expect(r1.strippedClaims).toEqual(r2.strippedClaims);
  });

  it("ungrounded output matches golden file content", () => {
    const goldenPath = resolve(__dirname, "../fixtures/golden-files/ungrounded-response.txt");
    const golden = readFileSync(goldenPath, "utf8").trim();
    const result = assemble(FABRICATED_OFFER_MODEL_OUTPUT, makeEmptyLedger());
    expect(result.safeText).toBe(golden);
  });
});
