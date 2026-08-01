#!/usr/bin/env npx tsx
/**
 * Synthetic data seed CLI.
 *
 * Creates deterministic, namespaced synthetic travelers, offers, bookings,
 * itineraries, and conversations in a staging environment for E2E test runs.
 *
 * BR-18 / R12 compliance: REFUSES to run against a production-tagged environment.
 * All seeded data uses synthetic PII only — no real identities or documents.
 *
 * Usage:
 *   E2E_SEED_RUN_ID=my-run-001 npx tsx tools/seed-synthetic/index.ts
 *
 * Environment variables:
 *   SEED_API_URL      - API base URL (must NOT be production-tagged)
 *   E2E_SEED_RUN_ID   - Unique run namespace (default: "local")
 *   SEED_API_KEY      - API key for seed endpoints
 *   SEED_DRY_RUN      - Set to "1" to print the seed plan without executing
 */

import process from "process";

// ---------------------------------------------------------------------------
// BR-18: Production guard — refuse to run against production
// ---------------------------------------------------------------------------

const PRODUCTION_URL_PATTERNS = [
  /production/i,
  /prod\./i,
  /\.prod\./i,
  /api\.travelplatform\.com/i,
  /travelplatform\.io/i,
];

const PRODUCTION_ENV_TAGS = ["production", "prod"];

function assertNotProduction(apiUrl: string): void {
  // Check URL pattern
  if (PRODUCTION_URL_PATTERNS.some((p) => p.test(apiUrl))) {
    console.error(
      `\n[BR-18] REFUSED: The seed tool must not run against a production environment.\n` +
        `  URL: ${apiUrl}\n` +
        `  If this is staging, update the URL to not match production patterns.\n`
    );
    process.exit(1);
  }

  // Check environment tag from API
  const envTag = process.env["SEED_ENV_TAG"]?.toLowerCase() ?? "";
  if (PRODUCTION_ENV_TAGS.includes(envTag)) {
    console.error(
      `\n[BR-18] REFUSED: SEED_ENV_TAG="${envTag}" indicates a production environment.\n` +
        `  The seed tool must only run against environments tagged as staging or test.\n`
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_URL = process.env["SEED_API_URL"] ?? "http://localhost:4000";
const RUN_ID = process.env["E2E_SEED_RUN_ID"] ?? "local";
const API_KEY = process.env["SEED_API_KEY"] ?? "synthetic-seed-key";
const DRY_RUN = process.env["SEED_DRY_RUN"] === "1";

// Deterministic ID generator: <entity>-<run-id>-<index>
function seedId(entity: string, index: number | string): string {
  return `synthetic-${entity}-${RUN_ID}-${index}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BookingStatus =
  | "PENDING"
  | "CONFIRMED"
  | "CANCELLED"
  | "EXPIRED";

type OfferProvenance = "amadeus" | "sabre" | "travelport" | "direct";

interface SyntheticTraveler {
  id: string;
  email: string;
  password: string;
  displayName: string;
  type: "authenticated" | "guest";
}

interface SyntheticOffer {
  id: string;
  type: "flight" | "hotel" | "car";
  provenance: OfferProvenance;
  origin?: string;
  destination?: string;
  price: number;
  currency: string;
  isStale?: boolean;
  hasPriceIncrease?: boolean;
  hasPriceDecrease?: boolean;
  supplierId: string;
  validUntil: string;
}

interface SyntheticBooking {
  id: string;
  travelerId: string;
  offerId: string;
  status: BookingStatus;
  idempotencyKey: string;
  expiresAt?: string;
  paymentRoute: string;
  hasDocument?: boolean;
}

interface SyntheticItinerary {
  id: string;
  travelerId: string;
  itemIds: string[];
}

interface SyntheticConversation {
  id: string;
  travelerId: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

async function apiPost(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (DRY_RUN) {
    console.log(`[DRY-RUN] POST ${API_URL}${path}`, JSON.stringify(body, null, 2));
    return { ok: true, status: 200, data: body };
  }

  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "x-seed-run-id": RUN_ID,
      "x-synthetic": "true",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function apiGet(path: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (DRY_RUN) {
    console.log(`[DRY-RUN] GET ${API_URL}${path}`);
    return { ok: true, status: 200, data: {} };
  }

  const res = await fetch(`${API_URL}${path}`, {
    headers: {
      "x-api-key": API_KEY,
      "x-seed-run-id": RUN_ID,
    },
  });

  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Seed functions (idempotent — safe to re-run)
// ---------------------------------------------------------------------------

async function seedTraveler(traveler: SyntheticTraveler): Promise<void> {
  console.log(`  → Seeding traveler: ${traveler.id} (${traveler.email})`);

  const existing = await apiGet(`/api/v1/synthetic/travelers/${traveler.id}`);
  if (existing.ok && existing.status === 200) {
    console.log(`    (already exists — skipping)`);
    return;
  }

  const result = await apiPost("/api/v1/synthetic/travelers", traveler);
  if (!result.ok) {
    console.warn(`    Warning: Failed to seed traveler ${traveler.id} (${result.status})`);
  }
}

async function seedOffer(offer: SyntheticOffer): Promise<void> {
  console.log(`  → Seeding offer: ${offer.id} (${offer.type}/${offer.provenance})`);

  const existing = await apiGet(`/api/v1/synthetic/offers/${offer.id}`);
  if (existing.ok && existing.status === 200) {
    console.log(`    (already exists — skipping)`);
    return;
  }

  const result = await apiPost("/api/v1/synthetic/offers", offer);
  if (!result.ok) {
    console.warn(`    Warning: Failed to seed offer ${offer.id} (${result.status})`);
  }
}

async function seedBooking(booking: SyntheticBooking): Promise<void> {
  console.log(`  → Seeding booking: ${booking.id} (${booking.status})`);

  const existing = await apiGet(`/api/v1/synthetic/bookings/${booking.id}`);
  if (existing.ok && existing.status === 200) {
    console.log(`    (already exists — skipping)`);
    return;
  }

  const result = await apiPost("/api/v1/synthetic/bookings", booking);
  if (!result.ok) {
    console.warn(`    Warning: Failed to seed booking ${booking.id} (${result.status})`);
  }
}

async function seedItinerary(itinerary: SyntheticItinerary): Promise<void> {
  console.log(`  → Seeding itinerary: ${itinerary.id}`);

  const existing = await apiGet(`/api/v1/synthetic/itineraries/${itinerary.id}`);
  if (existing.ok && existing.status === 200) {
    console.log(`    (already exists — skipping)`);
    return;
  }

  const result = await apiPost("/api/v1/synthetic/itineraries", itinerary);
  if (!result.ok) {
    console.warn(`    Warning: Failed to seed itinerary ${itinerary.id} (${result.status})`);
  }
}

async function seedConversation(conversation: SyntheticConversation): Promise<void> {
  console.log(`  → Seeding conversation: ${conversation.id}`);

  const existing = await apiGet(`/api/v1/synthetic/conversations/${conversation.id}`);
  if (existing.ok && existing.status === 200) {
    console.log(`    (already exists — skipping)`);
    return;
  }

  const result = await apiPost("/api/v1/synthetic/conversations", conversation);
  if (!result.ok) {
    console.warn(`    Warning: Failed to seed conversation ${conversation.id} (${result.status})`);
  }
}

// ---------------------------------------------------------------------------
// Seed plan
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  console.log(`\n=== Synthetic Seed Tool ===`);
  console.log(`Run ID:  ${RUN_ID}`);
  console.log(`API URL: ${API_URL}`);
  console.log(`Mode:    ${DRY_RUN ? "DRY-RUN (no writes)" : "LIVE"}\n`);

  // BR-18: Refuse production
  assertNotProduction(API_URL);

  // ── 1. Travelers ──────────────────────────────────────────────────────────
  console.log("Seeding travelers...");

  const authenticatedTraveler: SyntheticTraveler = {
    id: seedId("traveler", "auth"),
    email: `e2e+${RUN_ID}@synthetic.travelplatform.example.com`,
    password: "SyntheticPass1!",
    displayName: "E2E Test Traveler",
    type: "authenticated",
  };

  const guestTraveler: SyntheticTraveler = {
    id: seedId("traveler", "guest"),
    email: `e2e+guest-${RUN_ID}@synthetic.travelplatform.example.com`,
    password: "GuestCarryover1!",
    displayName: "E2E Guest Traveler",
    type: "guest",
  };

  await seedTraveler(authenticatedTraveler);
  await seedTraveler(guestTraveler);

  // ── 2. Offers (one per provenance value) ─────────────────────────────────
  console.log("\nSeeding offers...");

  const TOMORROW_ISO = new Date(Date.now() + 86_400_000).toISOString().split("T")[0]!;
  const NEXT_WEEK_ISO = new Date(Date.now() + 7 * 86_400_000).toISOString().split("T")[0]!;

  const offers: SyntheticOffer[] = [
    // Standard flight offers per provenance
    {
      id: seedId("offer", "flight-amadeus"),
      type: "flight",
      provenance: "amadeus",
      origin: "JFK",
      destination: "LHR",
      price: 450.00,
      currency: "USD",
      supplierId: "AA100",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
    {
      id: seedId("offer", "flight-sabre"),
      type: "flight",
      provenance: "sabre",
      origin: "JFK",
      destination: "CDG",
      price: 520.00,
      currency: "USD",
      supplierId: "BA123",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
    {
      id: seedId("offer", "flight-travelport"),
      type: "flight",
      provenance: "travelport",
      origin: "LHR",
      destination: "DXB",
      price: 380.00,
      currency: "GBP",
      supplierId: "EK500",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
    {
      id: seedId("offer", "flight-direct"),
      type: "flight",
      provenance: "direct",
      origin: "LAX",
      destination: "NRT",
      price: 890.00,
      currency: "USD",
      supplierId: "NH200",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
    // Hotel offer
    {
      id: seedId("offer", "hotel-london"),
      type: "hotel",
      provenance: "amadeus",
      destination: "LHR",
      price: 220.00,
      currency: "GBP",
      supplierId: "HOTEL-LHR-001",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
    // Car rental offer
    {
      id: seedId("offer", "car-lax"),
      type: "car",
      provenance: "direct",
      origin: "LAX",
      price: 75.00,
      currency: "USD",
      supplierId: "CAR-LAX-001",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
    // Stale offer for checkout tests
    {
      id: "synthetic-stale-offer",
      type: "flight",
      provenance: "amadeus",
      origin: "JFK",
      destination: "LHR",
      price: 400.00,
      currency: "USD",
      isStale: true,
      supplierId: "AA101",
      validUntil: new Date(Date.now() - 3_600_000).toISOString(), // already expired
    },
    // Price increase offer
    {
      id: "synthetic-price-increase-offer",
      type: "flight",
      provenance: "amadeus",
      origin: "JFK",
      destination: "LHR",
      price: 500.00,
      currency: "USD",
      hasPriceIncrease: true,
      supplierId: "AA102",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
    // Price decrease offer
    {
      id: "synthetic-price-decrease-offer",
      type: "flight",
      provenance: "amadeus",
      origin: "JFK",
      destination: "LHR",
      price: 350.00,
      currency: "USD",
      hasPriceDecrease: true,
      supplierId: "AA103",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
    // Bookable offer for checkout tests
    {
      id: "synthetic-bookable-offer",
      type: "flight",
      provenance: "amadeus",
      origin: "JFK",
      destination: "LHR",
      price: 450.00,
      currency: "USD",
      supplierId: "AA104",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    },
  ];

  for (const offer of offers) {
    await seedOffer(offer);
  }

  // ── 3. Bookings (one per lifecycle state) ─────────────────────────────────
  console.log("\nSeeding bookings...");

  const PAST_TIMESTAMP = new Date(Date.now() - 3_600_000).toISOString(); // 1 hour ago

  const bookings: SyntheticBooking[] = [
    {
      id: seedId("booking", "pending"),
      travelerId: authenticatedTraveler.id,
      offerId: seedId("offer", "flight-amadeus"),
      status: "PENDING",
      idempotencyKey: `idem-${RUN_ID}-pending`,
      paymentRoute: "stripe",
    },
    {
      id: seedId("booking", "confirmed"),
      travelerId: authenticatedTraveler.id,
      offerId: seedId("offer", "flight-sabre"),
      status: "CONFIRMED",
      idempotencyKey: `idem-${RUN_ID}-confirmed`,
      paymentRoute: "stripe",
      hasDocument: true,
    },
    {
      id: seedId("booking", "cancelled"),
      travelerId: authenticatedTraveler.id,
      offerId: seedId("offer", "flight-travelport"),
      status: "CANCELLED",
      idempotencyKey: `idem-${RUN_ID}-cancelled`,
      paymentRoute: "stripe",
    },
    {
      id: seedId("booking", "expired"),
      travelerId: authenticatedTraveler.id,
      offerId: seedId("offer", "flight-direct"),
      status: "EXPIRED",
      idempotencyKey: `idem-${RUN_ID}-expired`,
      expiresAt: PAST_TIMESTAMP,
      paymentRoute: "stripe",
    },
    // Fixed IDs for env var references in spec files
    {
      id: "synthetic-expired-001",
      travelerId: authenticatedTraveler.id,
      offerId: seedId("offer", "flight-amadeus"),
      status: "EXPIRED",
      idempotencyKey: `idem-${RUN_ID}-expired-001`,
      expiresAt: PAST_TIMESTAMP,
      paymentRoute: "stripe",
    },
    {
      id: "synthetic-confirmed-001",
      travelerId: authenticatedTraveler.id,
      offerId: seedId("offer", "flight-sabre"),
      status: "CONFIRMED",
      idempotencyKey: `idem-${RUN_ID}-confirmed-001`,
      paymentRoute: "stripe",
    },
    {
      id: "synthetic-pending-001",
      travelerId: authenticatedTraveler.id,
      offerId: seedId("offer", "flight-amadeus"),
      status: "PENDING",
      idempotencyKey: `idem-${RUN_ID}-pending-001`,
      paymentRoute: "stripe",
    },
    {
      id: "synthetic-confirmed-with-doc-001",
      travelerId: authenticatedTraveler.id,
      offerId: seedId("offer", "hotel-london"),
      status: "CONFIRMED",
      idempotencyKey: `idem-${RUN_ID}-doc-001`,
      paymentRoute: "stripe",
      hasDocument: true,
    },
  ];

  for (const booking of bookings) {
    await seedBooking(booking);
  }

  // ── 4. Itineraries ────────────────────────────────────────────────────────
  console.log("\nSeeding itineraries...");

  const itinerary: SyntheticItinerary = {
    id: seedId("itinerary", "main"),
    travelerId: authenticatedTraveler.id,
    itemIds: [
      seedId("offer", "flight-amadeus"),
      seedId("offer", "hotel-london"),
    ],
  };

  await seedItinerary(itinerary);

  // ── 5. Conversations ──────────────────────────────────────────────────────
  console.log("\nSeeding conversations...");

  const conversation: SyntheticConversation = {
    id: seedId("conversation", "main"),
    travelerId: authenticatedTraveler.id,
    messages: [
      { role: "user", content: "Find me a flight from JFK to LHR" },
      {
        role: "assistant",
        content:
          "I found several options for your JFK to LHR journey. Here are the best matches:",
      },
    ],
  };

  await seedConversation(conversation);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n✓ Seeding complete for run: ${RUN_ID}`);
  console.log(`  Travelers:     ${2}`);
  console.log(`  Offers:        ${offers.length}`);
  console.log(`  Bookings:      ${bookings.length}`);
  console.log(`  Itineraries:   ${1}`);
  console.log(`  Conversations: ${1}`);

  if (DRY_RUN) {
    console.log(`\n[DRY-RUN] No data was written. Remove SEED_DRY_RUN=1 to execute.\n`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

run().catch((err) => {
  console.error(`\n[FATAL] Seed tool failed:`, err);
  process.exit(1);
});
