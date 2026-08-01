"use client";

import * as React from "react";
import type {
  ListingDetail,
  AvailabilityResponse,
  QuoteResponse,
} from "@/lib/api/listings.js";
import { getAvailability, getQuote } from "@/lib/api/listings.js";
import {
  computeNights,
  isRangeAvailable,
  validateMinimumStay,
  validateCheckInDay,
  findNearestAvailableRange,
} from "@/lib/booking/availability.js";
import { saveDraft } from "@/lib/booking/draft.js";

interface BookingWidgetProps {
  listing: ListingDetail;
}

type Phase = "idle" | "loading_avail" | "checking" | "quoting" | "ready" | "error";

function formatCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

export function BookingWidget({ listing }: BookingWidgetProps) {
  const today = new Date().toISOString().slice(0, 10);
  const [checkIn, setCheckIn] = React.useState("");
  const [checkOut, setCheckOut] = React.useState("");
  const [adults, setAdults] = React.useState(1);
  const [children, setChildren] = React.useState(0);
  const [infants, setInfants] = React.useState(0);
  const [availability, setAvailability] = React.useState<AvailabilityResponse | null>(null);
  const [quote, setQuote] = React.useState<QuoteResponse | null>(null);
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [errorMsg, setErrorMsg] = React.useState("");
  const [validationMsg, setValidationMsg] = React.useState("");
  const [suggestion, setSuggestion] = React.useState<{ checkIn: string; checkOut: string } | null>(null);

  const nights = checkIn && checkOut ? computeNights(checkIn, checkOut) : 0;
  const totalGuests = adults + children + infants;

  // Fetch availability window when dates change enough to have a range
  React.useEffect(() => {
    if (!checkIn) return;
    let cancelled = false;
    const from = checkIn;
    // Fetch 3 months ahead
    const to = new Date(new Date(checkIn).getTime() + 90 * 86400000).toISOString().slice(0, 10);
    setPhase("loading_avail");
    setValidationMsg("");
    setSuggestion(null);

    const ac = new AbortController();
    getAvailability(listing.id, from, to, ac.signal)
      .then((av) => {
        if (!cancelled) {
          setAvailability(av);
          setPhase("idle");
        }
      })
      .catch((e) => {
        if (!cancelled && e.name !== "AbortError") {
          setPhase("error");
          setErrorMsg("Could not load availability. Please try again.");
        }
      });

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [checkIn, listing.id]);

  // Validate when both dates are present
  React.useEffect(() => {
    if (!checkIn || !checkOut || !availability) return;
    setValidationMsg("");
    setSuggestion(null);

    const dayValidation = validateCheckInDay(checkIn, availability);
    if (!dayValidation.valid) {
      setValidationMsg("Check-in is not allowed on that day of the week.");
      return;
    }

    if (!isRangeAvailable(checkIn, checkOut, availability)) {
      setValidationMsg("Selected dates are not available.");
      const nearest = findNearestAvailableRange(checkIn, listing.minimumStay, availability, listing.minimumStay);
      if (nearest) setSuggestion(nearest);
      return;
    }

    const stayValidation = validateMinimumStay(
      checkIn,
      checkOut,
      availability,
      listing.minimumStay,
      listing.maximumStay,
    );
    if (!stayValidation.valid) {
      const v = stayValidation as { reason: string; minimum?: number; maximum?: number };
      if (v.reason === "minimum_stay" && v.minimum) {
        setValidationMsg(`Minimum stay is ${v.minimum} nights.`);
        const nearest = findNearestAvailableRange(checkIn, v.minimum, availability, listing.minimumStay);
        if (nearest) setSuggestion(nearest);
      } else if (v.reason === "maximum_stay" && v.maximum) {
        setValidationMsg(`Maximum stay is ${v.maximum} nights.`);
      }
    }
  }, [checkIn, checkOut, availability, listing.minimumStay, listing.maximumStay]);

  async function handleGetQuote() {
    if (!checkIn || !checkOut || validationMsg) return;
    setPhase("quoting");
    setErrorMsg("");
    setQuote(null);

    try {
      const q = await getQuote(listing.id, {
        checkIn,
        checkOut,
        adults,
        children,
        infants,
        currency: listing.currency,
      });
      setQuote(q);
      setPhase("ready");
    } catch {
      setPhase("error");
      setErrorMsg("Could not get a price quote. Please try again.");
    }
  }

  function handleReserve() {
    if (!quote) return;
    saveDraft({
      listingId: listing.id,
      listingSlug: listing.slug,
      checkIn,
      checkOut,
      adults,
      children,
      infants,
      quoteId: quote.quoteId,
      quoteExpiresAt: quote.expiresAt,
      currency: quote.currency,
      total: quote.total,
    });
    window.location.href = `/checkout/${listing.slug}`;
  }

  function applySuggestion() {
    if (!suggestion) return;
    setCheckIn(suggestion.checkIn);
    setCheckOut(suggestion.checkOut);
    setSuggestion(null);
  }

  const canGetQuote =
    checkIn && checkOut && !validationMsg && phase !== "loading_avail" && phase !== "quoting";

  return (
    <div className="rounded-2xl border border-neutral-200 p-6 shadow-md">
      {/* Price header */}
      <p className="mb-4 text-lg font-semibold text-neutral-900">
        {formatCurrency(0, listing.currency).replace("0.00", "–")} /{" "}
        <span className="font-normal text-neutral-600 text-base">night</span>
      </p>

      <form
        onSubmit={(e) => { e.preventDefault(); handleGetQuote(); }}
        aria-label="Booking request"
      >
        {/* Date inputs */}
        <div className="mb-3 grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="bw-check-in" className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
              Check-in
            </label>
            <input
              id="bw-check-in"
              type="date"
              min={today}
              value={checkIn}
              onChange={(e) => {
                setCheckIn(e.target.value);
                setQuote(null);
                if (checkOut && e.target.value >= checkOut) setCheckOut("");
              }}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
              required
            />
          </div>
          <div>
            <label htmlFor="bw-check-out" className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
              Check-out
            </label>
            <input
              id="bw-check-out"
              type="date"
              min={checkIn || today}
              value={checkOut}
              onChange={(e) => { setCheckOut(e.target.value); setQuote(null); }}
              className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
              required
            />
          </div>
        </div>

        {/* Guests */}
        <div className="mb-4">
          <label htmlFor="bw-guests" className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
            Guests
          </label>
          <div className="flex items-center gap-3 text-sm">
            {[
              { label: "Adults", value: adults, set: setAdults, min: 1 },
              { label: "Children", value: children, set: setChildren, min: 0 },
              { label: "Infants", value: infants, set: setInfants, min: 0 },
            ].map(({ label, value, set, min }) => (
              <div key={label} className="flex items-center gap-1">
                <span className="text-neutral-600">{label}:</span>
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-full border border-neutral-400 text-sm disabled:opacity-30"
                  onClick={() => set(Math.max(min, value - 1))}
                  disabled={value <= min}
                  aria-label={`Remove one ${label.toLowerCase()}`}
                >−</button>
                <span className="w-5 text-center tabular-nums" aria-live="polite">{value}</span>
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-full border border-neutral-400 text-sm disabled:opacity-30"
                  onClick={() => set(value + 1)}
                  disabled={totalGuests >= listing.maxGuests}
                  aria-label={`Add one ${label.toLowerCase()}`}
                >+</button>
              </div>
            ))}
          </div>
          {totalGuests >= listing.maxGuests && (
            <p className="mt-1 text-xs text-amber-600">Maximum {listing.maxGuests} guests</p>
          )}
        </div>

        {/* Validation message */}
        {validationMsg && (
          <div role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {validationMsg}
            {suggestion && (
              <button
                type="button"
                className="ml-2 underline"
                onClick={applySuggestion}
              >
                Try {suggestion.checkIn} → {suggestion.checkOut}
              </button>
            )}
          </div>
        )}

        {/* Error message */}
        {errorMsg && (
          <div role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMsg}
          </div>
        )}

        {/* Quote breakdown */}
        {quote && phase === "ready" && (
          <div className="mb-4 rounded-lg bg-neutral-50 p-3 text-sm">
            <div className="space-y-1">
              {quote.lineItems.map((li) => (
                <div key={li.code} className="flex justify-between">
                  <span className="text-neutral-600">{li.label}</span>
                  <span>{formatCurrency(li.amount, quote.currency)}</span>
                </div>
              ))}
              {quote.discounts.map((d) => (
                <div key={d.code} className="flex justify-between text-green-700">
                  <span>{d.label}</span>
                  <span>−{formatCurrency(d.amount, quote.currency)}</span>
                </div>
              ))}
              {quote.taxes.map((t) => (
                <div key={t.label} className="flex justify-between text-neutral-500">
                  <span>{t.label}</span>
                  <span>{formatCurrency(t.amount, quote.currency)}</span>
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-between border-t border-neutral-200 pt-2 font-semibold">
              <span>Total ({quote.nights} nights)</span>
              <span>{formatCurrency(quote.total, quote.currency)}</span>
            </div>
          </div>
        )}

        {/* Primary action */}
        {phase !== "ready" ? (
          <button
            type="submit"
            disabled={!canGetQuote}
            className="w-full rounded-xl bg-rose-600 py-3 text-sm font-semibold text-white disabled:opacity-50 hover:bg-rose-700"
          >
            {phase === "quoting"
              ? "Getting price…"
              : phase === "loading_avail"
              ? "Checking availability…"
              : nights > 0
              ? `Get price — ${nights} night${nights > 1 ? "s" : ""}`
              : "Check availability"}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleReserve}
            className="w-full rounded-xl bg-rose-600 py-3 text-sm font-semibold text-white hover:bg-rose-700"
          >
            Reserve
          </button>
        )}
      </form>
    </div>
  );
}
