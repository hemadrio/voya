"use client";

/**
 * ReviewStep — step 3: quote re-validation and price-change disclosure (WO-068, AC5).
 *
 * Calls /quotes/{quoteId}/revalidate on mount.
 * Shows PriceChangeDialog when a price difference is detected.
 * Requires explicit acknowledgement before enabling payment navigation.
 */

import { useEffect, useState } from "react";
import { revalidateQuote } from "@/lib/api/bookings.js";
import type { RevalidatedQuote } from "@/lib/api/bookings.js";
import { PriceSummary } from "./PriceSummary.js";
import { PriceChangeDialog } from "./PriceChangeDialog.js";
import { Button } from "@/components/ui/Button.js";

interface ReviewStepProps {
  quoteId: string;
  currency: string;
  originalTotal: number;
  travelerSummary: {
    primaryName: string;
    email: string;
    guestCount: number;
  };
  checkIn: string;
  checkOut: string;
  onConfirm: (revalidatedQuote: RevalidatedQuote) => void;
  onBack: () => void;
}

export function ReviewStep({
  quoteId,
  currency,
  originalTotal,
  travelerSummary,
  checkIn,
  checkOut,
  onConfirm,
  onBack,
}: ReviewStepProps) {
  const [revalidating, setRevalidating] = useState(true);
  const [quote, setQuote] = useState<RevalidatedQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPriceChange, setShowPriceChange] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setRevalidating(true);
    setError(null);

    revalidateQuote(quoteId, controller.signal)
      .then((result) => {
        setQuote(result);
        if (result.changed) {
          setShowPriceChange(true);
        }
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        const code = (err as { code?: string }).code;
        if (code === "QUOTE_EXPIRED") {
          setError("Your quote has expired. Please return to the listing to get a fresh quote.");
        } else if (code === "DATES_UNAVAILABLE") {
          setError("These dates are no longer available. Please choose different dates.");
        } else {
          setError("Unable to confirm your quote. Please try again.");
        }
      })
      .finally(() => setRevalidating(false));

    return () => controller.abort();
  }, [quoteId]);

  function handleAcknowledge() {
    setShowPriceChange(false);
    setAcknowledged(true);
  }

  function handleDeclinePriceChange() {
    setShowPriceChange(false);
  }

  const canProceed = !!quote && (!quote.changed || acknowledged) && !revalidating;

  if (revalidating) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-sm text-neutral-500" role="status" aria-live="polite">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" aria-hidden="true" />
        Confirming your quote…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md bg-error-50 border border-error-300 p-4 text-sm text-error-700" role="alert">
        <p className="font-medium">Unable to proceed</p>
        <p className="mt-1">{error}</p>
        <Button variant="outline" className="mt-3" onClick={onBack}>
          Go back
        </Button>
      </div>
    );
  }

  return (
    <>
      {quote && showPriceChange && (
        <PriceChangeDialog
          isOpen={showPriceChange}
          currency={currency}
          previousTotal={quote.previousTotal ?? originalTotal}
          newTotal={quote.total}
          onAcknowledge={handleAcknowledge}
          onDecline={handleDeclinePriceChange}
        />
      )}

      <div className="space-y-5">
        {/* Booking summary */}
        <div className="rounded-lg border border-neutral-200 p-4 text-sm">
          <h3 className="mb-3 font-semibold text-neutral-900">Booking summary</h3>
          <dl className="space-y-1 text-neutral-600">
            <div className="flex justify-between">
              <dt>Check-in</dt>
              <dd className="font-medium text-neutral-900">{checkIn}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Check-out</dt>
              <dd className="font-medium text-neutral-900">{checkOut}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Primary traveler</dt>
              <dd className="font-medium text-neutral-900">{travelerSummary.primaryName}</dd>
            </div>
            {travelerSummary.guestCount > 0 && (
              <div className="flex justify-between">
                <dt>Additional guests</dt>
                <dd className="font-medium text-neutral-900">{travelerSummary.guestCount}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt>Email</dt>
              <dd className="font-medium text-neutral-900">{travelerSummary.email}</dd>
            </div>
          </dl>
        </div>

        {quote && (
          <PriceSummary
            currency={currency}
            lineItems={quote.lineItems}
            total={quote.total}
          />
        )}

        {quote?.changed && !acknowledged && (
          <div className="rounded-md bg-warning-50 border border-warning-200 px-4 py-3 text-sm text-warning-700" role="status">
            The price of your booking has changed. Please{" "}
            <button
              type="button"
              className="font-medium underline hover:no-underline"
              onClick={() => setShowPriceChange(true)}
            >
              review the price change
            </button>{" "}
            before continuing.
          </div>
        )}

        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onBack} type="button">
            Back
          </Button>
          <Button
            className="flex-1"
            disabled={!canProceed}
            onClick={() => quote && onConfirm(quote)}
            type="button"
          >
            Continue to payment
          </Button>
        </div>
      </div>
    </>
  );
}
