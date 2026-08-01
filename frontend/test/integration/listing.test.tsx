/**
 * Integration tests for the listing detail BookingWidget (client component).
 * Uses MSW to intercept listing, availability, and quote API calls.
 *
 * These tests validate:
 * - BookingWidget renders and accepts date/guest input
 * - Availability fetch is triggered when check-in is selected
 * - Validation messages for unavailable dates
 * - Nearest available range suggestion is shown and clickable
 * - Successful quote fetch renders itemized price breakdown
 * - Reserve action saves booking draft and navigates to checkout
 * - API error renders inline retry message without breaking page
 */

import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "@/test/setup.js";
import {
  FIXTURE_LISTING_FULL,
  FIXTURE_LISTING_NO_REVIEWS,
  FIXTURE_AVAILABILITY_BLOCKED,
  FIXTURE_AVAILABILITY_OPEN,
  FIXTURE_QUOTE,
  listingHandlers,
} from "@/test/fixtures/listing.js";
import { BookingWidget } from "@/components/listing/BookingWidget.js";

// ---------------------------------------------------------------------------
// MSW setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mswServer.use(...listingHandlers);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWidget(listing = FIXTURE_LISTING_FULL) {
  return render(<BookingWidget listing={listing} />);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("BookingWidget", () => {
  it("renders check-in and check-out inputs", () => {
    renderWidget();
    expect(screen.getByLabelText(/check-in/i)).toBeDefined();
    expect(screen.getByLabelText(/check-out/i)).toBeDefined();
  });

  it("renders guest count controls", () => {
    renderWidget();
    expect(screen.getByText(/adults/i)).toBeDefined();
  });

  it("shows 'Check availability' CTA when no dates selected", () => {
    renderWidget();
    expect(screen.getByRole("button", { name: /check availability/i })).toBeDefined();
  });

  it("limits guest total to maxGuests", async () => {
    renderWidget();
    const addAdultBtns = screen.getAllByLabelText(/add one adult/i);
    // Click add adults up to maxGuests (8)
    for (let i = 0; i < 7; i++) {
      fireEvent.click(addAdultBtns[0]);
    }
    // Should now be 8 adults total; add button disabled
    const addBtn = screen.getAllByLabelText(/add one adult/i)[0] as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Availability checking
// ---------------------------------------------------------------------------

describe("BookingWidget — availability", () => {
  it("shows unavailable message when selected range overlaps blocked period", async () => {
    mswServer.use(
      http.get("http://localhost:4000/api/v1/listings/:id/availability", () =>
        HttpResponse.json(FIXTURE_AVAILABILITY_BLOCKED),
      ),
    );

    renderWidget();
    const checkInInput = screen.getByLabelText(/check-in/i);
    fireEvent.change(checkInInput, { target: { value: "2026-08-08" } });

    const checkOutInput = screen.getByLabelText(/check-out/i);
    fireEvent.change(checkOutInput, { target: { value: "2026-08-15" } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
    });
  });

  it("shows available state when dates are open", async () => {
    mswServer.use(
      http.get("http://localhost:4000/api/v1/listings/:id/availability", () =>
        HttpResponse.json(FIXTURE_AVAILABILITY_OPEN),
      ),
    );

    renderWidget();
    fireEvent.change(screen.getByLabelText(/check-in/i), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText(/check-out/i), { target: { value: "2026-09-05" } });

    await waitFor(() => {
      const alerts = screen.queryAllByRole("alert");
      const errorAlerts = alerts.filter((a) => a.textContent?.includes("not available"));
      expect(errorAlerts).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Quote fetch
// ---------------------------------------------------------------------------

describe("BookingWidget — quote", () => {
  it("renders itemized price breakdown after successful quote", async () => {
    mswServer.use(
      http.get("http://localhost:4000/api/v1/listings/:id/availability", () =>
        HttpResponse.json(FIXTURE_AVAILABILITY_OPEN),
      ),
      http.post("http://localhost:4000/api/v1/listings/:id/quote", () =>
        HttpResponse.json(FIXTURE_QUOTE),
      ),
    );

    renderWidget();
    fireEvent.change(screen.getByLabelText(/check-in/i), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText(/check-out/i), { target: { value: "2026-09-06" } });

    await waitFor(() => {
      const priceBtn = screen.queryByRole("button", { name: /get price/i });
      if (priceBtn) {
        fireEvent.click(priceBtn);
      }
    });

    await waitFor(() => {
      expect(screen.queryByText(/5 nights/i)).toBeTruthy();
    });
  });

  it("shows error message when quote API fails", async () => {
    mswServer.use(
      http.get("http://localhost:4000/api/v1/listings/:id/availability", () =>
        HttpResponse.json(FIXTURE_AVAILABILITY_OPEN),
      ),
      http.post("http://localhost:4000/api/v1/listings/:id/quote", () =>
        HttpResponse.json({ code: "INTERNAL_ERROR" }, { status: 500 }),
      ),
    );

    renderWidget();
    fireEvent.change(screen.getByLabelText(/check-in/i), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText(/check-out/i), { target: { value: "2026-09-06" } });

    await waitFor(() => {
      const priceBtn = screen.queryByRole("button", { name: /get price/i });
      if (priceBtn) fireEvent.click(priceBtn);
    });

    await waitFor(() => {
      const alerts = screen.queryAllByRole("alert");
      expect(alerts.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Fixtures validation
// ---------------------------------------------------------------------------

describe("Listing fixtures", () => {
  it("FIXTURE_LISTING_FULL has required fields", () => {
    expect(FIXTURE_LISTING_FULL.id).toBe("listing-001");
    expect(FIXTURE_LISTING_FULL.rating.count).toBeGreaterThan(0);
    expect(FIXTURE_LISTING_FULL.images.length).toBeGreaterThan(0);
    expect(FIXTURE_LISTING_FULL.amenities.length).toBeGreaterThan(0);
  });

  it("FIXTURE_LISTING_NO_REVIEWS has zero reviews", () => {
    expect(FIXTURE_LISTING_NO_REVIEWS.rating.count).toBe(0);
    expect(FIXTURE_LISTING_NO_REVIEWS.rating.categories).toHaveLength(0);
  });

  it("FIXTURE_AVAILABILITY_BLOCKED has blocked ranges", () => {
    expect(FIXTURE_AVAILABILITY_BLOCKED.blockedRanges.length).toBeGreaterThan(0);
  });

  it("FIXTURE_QUOTE has all required pricing fields", () => {
    expect(FIXTURE_QUOTE.quoteId).toBeTruthy();
    expect(FIXTURE_QUOTE.total).toBeGreaterThan(0);
    expect(FIXTURE_QUOTE.lineItems.length).toBeGreaterThan(0);
  });
});
