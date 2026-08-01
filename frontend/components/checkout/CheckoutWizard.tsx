"use client";

/**
 * CheckoutWizard — client-side multi-step checkout orchestrator (WO-068).
 *
 * Reads ?step= from URL, manages draft persistence, fires analytics events,
 * and renders the appropriate step component.
 *
 * Step order: traveler → extras → review → payment → /checkout/confirmation/{bookingId}
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { loadDraft, saveDraft, clearDraft, updateDraftStep } from "@/lib/booking/draft.js";
import type { BookingDraft } from "@/lib/booking/draft.js";
import { clearIdempotencyKey } from "@/lib/booking/idempotency.js";
import { isValidCheckoutStep, nextStep, prevStep, CHECKOUT_STEPS } from "@/lib/validation/checkout.js";
import type { CheckoutStep, TravelerDetailsValues, ExtrasValues } from "@/lib/validation/checkout.js";
import type { RevalidatedQuote } from "@/lib/api/bookings.js";
import type { BookingCreatedResponse } from "@/lib/api/bookings.js";
import { buildEvent, scrubEvent } from "@/lib/analytics/events.js";
import { WizardProgress } from "./WizardProgress.js";
import { TravelerDetailsStep } from "./TravelerDetailsStep.js";
import { ExtrasStep } from "./ExtrasStep.js";
import type { Extra } from "./ExtrasStep.js";
import { ReviewStep } from "./ReviewStep.js";
import { PaymentStep } from "./PaymentStep.js";
import type { PaymentElementRenderProps } from "./PaymentStep.js";

// ---------------------------------------------------------------------------
// Analytics helper (thin wrapper around buildEvent/scrubEvent)
// ---------------------------------------------------------------------------

function fireAnalyticsEvent(name: string, props: Record<string, unknown>, route: string) {
  try {
    const event = buildEvent(
      { name: name as never, properties: scrubEvent(props) },
      route,
    );
    // In production, send via analytics transport.  For now, emit to console in dev.
    if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
      console.debug("[analytics]", event);
    }
  } catch {
    // Non-fatal
  }
}

const CHECKOUT_ANALYTICS_STEP: Record<
  CheckoutStep,
  "passenger_details" | "review_price" | "payment" | "confirmation" | null
> = {
  traveler: "passenger_details",
  extras: null,  // extras is part of passenger_details flow in analytics schema
  review: "review_price",
  payment: "payment",
};

// ---------------------------------------------------------------------------
// Mock payment element
// Props mirror PaymentElementRenderProps — provider SDK replacement goes here.
// ---------------------------------------------------------------------------

function MockPaymentElement({
  clientSecret: _clientSecret,
  onPaymentConfirmed,
  onError: _onError,
}: PaymentElementRenderProps) {
  const [loading, setLoading] = useState(false);

  async function handlePay() {
    setLoading(true);
    // Simulate tokenization delay (replace with real provider SDK call)
    await new Promise((r) => setTimeout(r, 600));
    // In a real integration: stripe.confirmPayment() returns paymentIntentId
    onPaymentConfirmed(`pi_mock_${Date.now()}`);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4 text-center text-sm text-neutral-500">
        Payment element rendered by provider SDK
        <br />
        <span className="text-xs">(Stripe Elements / equivalent)</span>
      </div>
      <button
        type="button"
        onClick={handlePay}
        disabled={loading}
        className="w-full rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {loading ? "Processing…" : "Pay now"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

interface CheckoutWizardProps {
  /** Authenticated session user for prefill — null for guest checkout */
  sessionUser?: { firstName: string; lastName: string; email: string } | null;
  /** Available extras fetched server-side */
  availableExtras?: Extra[];
}

export function CheckoutWizard({
  sessionUser = null,
  availableExtras = [],
}: CheckoutWizardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const route = "/checkout";

  const [draft, setDraft] = useState<BookingDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [stepLoading, setStepLoading] = useState(false);
  const [revalidatedQuote, setRevalidatedQuote] = useState<RevalidatedQuote | null>(null);
  const confirmedBookingRef = useRef<{
    booking: BookingCreatedResponse;
    reference: string;
  } | null>(null);

  // Load draft from sessionStorage on mount
  useEffect(() => {
    const stored = loadDraft();
    if (!stored) {
      setDraftError("No booking draft found. Please start from a listing.");
      return;
    }
    if (new Date(stored.quoteExpiresAt).getTime() < Date.now()) {
      setDraftError("Your quote has expired. Please return to the listing for a fresh quote.");
      return;
    }
    // Ensure WO-068 fields are present (guard against drafts from WO-067 without them)
    if (!stored.draftId) {
      stored.draftId = crypto.randomUUID();
    }
    if (!stored.completedSteps) stored.completedSteps = [];
    if (!stored.stepData) stored.stepData = {};
    setDraft(stored);
    saveDraft(stored);
  }, []);

  // Derive the active step from URL param, defaulting to first uncompleted step
  const currentStep: CheckoutStep = useMemo(() => {
    if (!draft) return "traveler";
    const paramStep = searchParams.get("step");
    if (paramStep && isValidCheckoutStep(paramStep)) {
      // Don't allow skipping ahead past completed steps
      const stepIdx = CHECKOUT_STEPS.indexOf(paramStep);
      const maxAllowedIdx = draft.completedSteps.length; // 0-based: can be on the next uncompleted
      if (stepIdx <= maxAllowedIdx) return paramStep;
    }
    // Default to next uncompleted step
    const firstUncompleted = CHECKOUT_STEPS.find(
      (s) => !draft.completedSteps.includes(s),
    );
    return firstUncompleted ?? "payment";
  }, [draft, searchParams]);

  function navigateToStep(step: CheckoutStep) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("step", step);
    router.push(`${route}?${params.toString()}`);
  }

  function handleStepBack() {
    const prev = prevStep(currentStep);
    if (prev) navigateToStep(prev);
  }

  // Step 1 submit
  const handleTravelerSubmit = useCallback(
    async (data: TravelerDetailsValues) => {
      if (!draft) return;
      setStepLoading(true);
      const updated = updateDraftStep(draft, { traveler: data }, "traveler");
      setDraft(updated);
      setStepLoading(false);

      const analyticsStep = CHECKOUT_ANALYTICS_STEP["traveler"];
      if (analyticsStep) {
        fireAnalyticsEvent(
          "checkout_step",
          { step: analyticsStep, stepIndex: 1 },
          route,
        );
      }
      navigateToStep("extras");
    },
    [draft, route],
  );

  // Step 2 submit
  const handleExtrasSubmit = useCallback(
    async (
      quantities: Record<string, number>,
      promoCode?: string,
      promoDiscount?: { label: string; amount: number },
    ) => {
      if (!draft) return;
      setStepLoading(true);
      const extrasArr = Object.entries(quantities)
        .filter(([, qty]) => qty > 0)
        .map(([code, quantity]) => ({ code, quantity }));
      const extrasValues: ExtrasValues = {
        extras: extrasArr,
        promoCode: promoCode ?? "",
      };
      const updated = updateDraftStep(
        draft,
        { extras: extrasValues, promoCode: promoCode },
        "extras",
      );
      setDraft(updated);
      setStepLoading(false);

      const analyticsStep = CHECKOUT_ANALYTICS_STEP["extras"];
      if (analyticsStep) {
        fireAnalyticsEvent("checkout_step", { step: analyticsStep, stepIndex: 2 }, route);
      }
      navigateToStep("review");
    },
    [draft, route],
  );

  // Step 3 confirm (revalidated quote)
  const handleReviewConfirm = useCallback(
    (quote: RevalidatedQuote) => {
      if (!draft) return;
      setRevalidatedQuote(quote);
      const updated = updateDraftStep(
        draft,
        { priceChangeAcknowledged: quote.changed },
        "review",
      );
      const withTotal: BookingDraft = { ...updated, revalidatedTotal: quote.total };
      setDraft(withTotal);
      saveDraft(withTotal);

      fireAnalyticsEvent(
        "checkout_step",
        { step: "review_price", stepIndex: 3 },
        route,
      );
      navigateToStep("payment");
    },
    [draft, route],
  );

  // Step 4 — booking confirmed
  const handleBookingConfirmed = useCallback(
    (booking: BookingCreatedResponse, reference: string) => {
      confirmedBookingRef.current = { booking, reference };

      fireAnalyticsEvent(
        "checkout_step",
        { step: "payment", stepIndex: 4 },
        route,
      );
      fireAnalyticsEvent(
        "booking_confirmed",
        { bookingId: booking.bookingId, currency: draft?.currency },
        route,
      );

      clearDraft();
      clearIdempotencyKey();

      router.push(`/checkout/confirmation/${booking.bookingId}?ref=${encodeURIComponent(reference)}`);
    },
    [draft, route, router],
  );

  // Step 4 — booking failed
  const handleBookingFailed = useCallback(
    (reason: string) => {
      fireAnalyticsEvent("booking_failed", { reason }, route);
    },
    [route],
  );

  // Step 4 — payment attempted (fired before booking creation)
  const handlePaymentAttempted = useCallback(() => {
    fireAnalyticsEvent(
      "payment_attempted",
      { currency: draft?.currency },
      route,
    );
  }, [draft, route]);

  if (draftError) {
    return (
      <div className="mx-auto max-w-lg px-4 py-12">
        <div role="alert" className="rounded-md border border-error-300 bg-error-50 p-4 text-sm text-error-700">
          <p className="font-medium">Unable to start checkout</p>
          <p className="mt-1">{draftError}</p>
        </div>
        <a
          href="/"
          className="mt-4 inline-block text-sm text-brand-600 hover:underline"
        >
          Return to home
        </a>
      </div>
    );
  }

  if (!draft) {
    return (
      <div
        className="flex flex-col items-center gap-3 py-16 text-sm text-neutral-500"
        role="status"
        aria-live="polite"
      >
        <div
          className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent"
          aria-hidden="true"
        />
        Loading checkout…
      </div>
    );
  }

  const priceSummary = {
    currency: draft.currency,
    lineItems: [],
    total: draft.total,
  };

  const initialExtrasMap = Object.fromEntries(
    (draft.stepData.extras?.extras ?? []).map((e) => [e.code, e.quantity]),
  );

  return (
    <div>
      <WizardProgress
        currentStep={currentStep}
        completedSteps={draft.completedSteps}
        onStepClick={navigateToStep}
      />

      <div className="mt-6">
        {currentStep === "traveler" && (
          <TravelerDetailsStep
            initialValues={draft.stepData.traveler}
            sessionUser={sessionUser}
            guestCount={draft.adults + draft.children + draft.infants}
            onSubmit={handleTravelerSubmit}
            loading={stepLoading}
          />
        )}

        {currentStep === "extras" && (
          <ExtrasStep
            quoteId={draft.quoteId}
            availableExtras={availableExtras}
            priceSummary={priceSummary}
            initialExtras={initialExtrasMap}
            initialPromoCode={draft.stepData.promoCode}
            onSubmit={handleExtrasSubmit}
            onBack={handleStepBack}
            loading={stepLoading}
          />
        )}

        {currentStep === "review" && draft.stepData.traveler && (
          <ReviewStep
            quoteId={draft.quoteId}
            currency={draft.currency}
            originalTotal={draft.total}
            travelerSummary={{
              primaryName: `${draft.stepData.traveler.primary.firstName} ${draft.stepData.traveler.primary.lastName}`,
              email: draft.stepData.traveler.primary.email,
              guestCount: (draft.stepData.traveler.guests ?? []).length,
            }}
            checkIn={draft.checkIn}
            checkOut={draft.checkOut}
            onConfirm={handleReviewConfirm}
            onBack={handleStepBack}
          />
        )}

        {currentStep === "payment" && draft.stepData.traveler && (
          <PaymentStep
            quoteId={revalidatedQuote?.quoteId ?? draft.quoteId}
            draftId={draft.draftId}
            currency={draft.currency}
            revalidatedTotal={draft.revalidatedTotal ?? draft.total}
            travelerDetails={draft.stepData.traveler}
            extras={draft.stepData.extras ?? { extras: [], promoCode: "" }}
            renderPaymentElement={(props) => <MockPaymentElement {...props} />}
            onPaymentAttempted={handlePaymentAttempted}
            onBookingConfirmed={handleBookingConfirmed}
            onBookingFailed={handleBookingFailed}
            onBack={handleStepBack}
          />
        )}
      </div>
    </div>
  );
}
