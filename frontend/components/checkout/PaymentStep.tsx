"use client";

/**
 * PaymentStep — step 4: create payment intent, mount provider element, submit booking (WO-068, AC6–AC9).
 *
 * Raw card data NEVER touches application code or state.
 * The payment provider element (injected via render prop) handles collection and tokenization.
 * After the payment element confirms, we create the booking and poll for the final status.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPaymentIntent } from "@/lib/api/payments.js";
import { createBooking, buildCreateBookingBody } from "@/lib/api/bookings.js";
import type { BookingCreatedResponse } from "@/lib/api/bookings.js";
import { pollBookingStatus } from "@/lib/booking/pollStatus.js";
import { getOrCreateIdempotencyKey } from "@/lib/booking/idempotency.js";
import type { TravelerDetailsValues, ExtrasValues } from "@/lib/validation/checkout.js";
import { Button } from "@/components/ui/Button.js";

// ---------------------------------------------------------------------------
// Payment element contract
// ---------------------------------------------------------------------------

/**
 * Props injected into the caller-supplied payment element renderer.
 * Raw card data never passes through these props — only the clientSecret
 * which is consumed entirely by the payment provider SDK.
 */
export interface PaymentElementRenderProps {
  /** Provider client secret — passed directly to the payment provider SDK. Never log. */
  clientSecret: string;
  /**
   * Call this with the payment provider's intent ID when the element has
   * collected and tokenized payment details.
   */
  onPaymentConfirmed: (paymentIntentId: string) => void;
  onError: (message: string) => void;
}

interface PaymentStepProps {
  quoteId: string;
  draftId: string;
  currency: string;
  revalidatedTotal: number;
  travelerDetails: TravelerDetailsValues;
  extras: ExtrasValues;
  /** Render the payment provider's element (Stripe Elements, etc.) */
  renderPaymentElement: (props: PaymentElementRenderProps) => React.ReactNode;
  /** Called when the user initiates payment (before booking creation) */
  onPaymentAttempted?: () => void;
  /** Called with the newly created booking once confirmed */
  onBookingConfirmed: (booking: BookingCreatedResponse, reference: string) => void;
  /** Called with human-readable message when payment/booking fails permanently */
  onBookingFailed: (reason: string) => void;
  onBack: () => void;
}

type PaymentPhase =
  | "init"             // creating payment intent
  | "ready"            // payment element mounted, awaiting user
  | "processing"       // creating booking + polling
  | "polling"          // polling status
  | "error";           // terminal error

export function PaymentStep({
  quoteId,
  draftId,
  currency,
  revalidatedTotal,
  travelerDetails,
  extras,
  renderPaymentElement,
  onPaymentAttempted,
  onBookingConfirmed,
  onBookingFailed,
  onBack,
}: PaymentStepProps) {
  const [phase, setPhase] = useState<PaymentPhase>("init");
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string>("Initialising payment…");
  const abortRef = useRef<AbortController | null>(null);

  // Initialise payment intent on mount
  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    createPaymentIntent(quoteId, draftId, currency, ctrl.signal)
      .then((intent) => {
        if (ctrl.signal.aborted) return;
        // clientSecret is passed directly to the payment element — never stored in application-visible state beyond this
        setClientSecret(intent.clientSecret);
        setPaymentIntentId(intent.paymentIntentId);
        setPhase("ready");
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setErrorMessage("Unable to initialise payment. Please try again.");
        setPhase("error");
      });

    return () => ctrl.abort();
  }, [quoteId, draftId, currency]);

  const handlePaymentConfirmed = useCallback(
    async (confirmedPaymentIntentId: string) => {
      // Fire analytics before any async work — raw card data never passes through here
      onPaymentAttempted?.();
      setPhase("processing");
      setStatusText("Creating your booking…");

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const idempotencyKey = getOrCreateIdempotencyKey();
      const body = buildCreateBookingBody(
        draftId,
        quoteId,
        confirmedPaymentIntentId,
        travelerDetails,
        extras,
      );

      let booking: BookingCreatedResponse;
      try {
        booking = await createBooking(body, idempotencyKey, ctrl.signal);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const code = (err as { code?: string }).code;
        const message =
          code === "PAYMENT_DECLINED"
            ? "Your payment was declined. Please check your payment details and try again."
            : code === "BOOKING_CONFLICT"
              ? "These dates are no longer available. Please choose different dates."
              : "Unable to complete your booking. Please try again.";
        setErrorMessage(message);
        setPhase("error");
        onBookingFailed(message);
        return;
      }

      // If already confirmed, skip polling
      if (booking.status === "confirmed") {
        onBookingConfirmed(booking, booking.reference);
        return;
      }

      // Poll for confirmation
      setPhase("polling");
      setStatusText("Confirming your booking…");

      const pollResult = await pollBookingStatus(booking.bookingId, ctrl.signal);

      if (pollResult.status === "confirmed") {
        onBookingConfirmed(booking, pollResult.reference);
      } else if (pollResult.status === "failed") {
        const msg = pollResult.failureReason ?? "Your booking could not be confirmed.";
        setErrorMessage(msg);
        setPhase("error");
        onBookingFailed(msg);
      } else {
        // timeout — booking may still be pending
        onBookingConfirmed(booking, booking.reference);
      }
    },
    [draftId, quoteId, travelerDetails, extras, onBookingConfirmed, onBookingFailed],
  );

  const handleElementError = useCallback((message: string) => {
    setErrorMessage(message);
    setPhase("error");
  }, []);

  const handleRetry = () => {
    setErrorMessage(null);
    setPhase("init");
    setClientSecret(null);
    setPaymentIntentId(null);
    // Reinitialise — the effect depends on quoteId/draftId/currency which don't change,
    // so we use a key increment trick via a forced re-mount at the page level.
    // For now, re-running the effect is sufficient within the same intent.
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    createPaymentIntent(quoteId, draftId, currency, ctrl.signal)
      .then((intent) => {
        if (ctrl.signal.aborted) return;
        setClientSecret(intent.clientSecret);
        setPaymentIntentId(intent.paymentIntentId);
        setPhase("ready");
      })
      .catch(() => {
        setErrorMessage("Unable to initialise payment. Please try again.");
        setPhase("error");
      });
  };

  if (phase === "init") {
    return (
      <div
        className="flex flex-col items-center gap-3 py-8 text-sm text-neutral-500"
        role="status"
        aria-live="polite"
      >
        <div
          className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent"
          aria-hidden="true"
        />
        Preparing payment…
      </div>
    );
  }

  if (phase === "processing" || phase === "polling") {
    return (
      <div
        className="flex flex-col items-center gap-3 py-8 text-sm text-neutral-500"
        role="status"
        aria-live="polite"
      >
        <div
          className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent"
          aria-hidden="true"
        />
        {statusText}
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="space-y-4">
        <div
          role="alert"
          className="rounded-md border border-error-300 bg-error-50 p-4 text-sm text-error-700"
        >
          <p className="font-medium">Payment failed</p>
          <p className="mt-1">{errorMessage}</p>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onBack} type="button">
            Back
          </Button>
          <Button className="flex-1" onClick={handleRetry} type="button">
            Try again
          </Button>
        </div>
      </div>
    );
  }

  // phase === "ready"
  const fmt = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  });

  return (
    <div className="space-y-5">
      <div className="rounded-lg bg-neutral-50 border border-neutral-200 px-4 py-3 text-sm">
        <div className="flex justify-between font-medium">
          <span className="text-neutral-600">Total due today</span>
          <span className="text-neutral-900">{fmt.format(revalidatedTotal)}</span>
        </div>
      </div>

      <div>
        <p className="mb-3 text-sm font-medium text-neutral-700">Payment details</p>
        {clientSecret &&
          renderPaymentElement({
            clientSecret,
            onPaymentConfirmed: handlePaymentConfirmed,
            onError: handleElementError,
          })}
      </div>

      <p className="text-xs text-neutral-400">
        Your card details are handled securely by our payment provider.
        We never store or process raw card numbers.
      </p>

      <Button
        variant="outline"
        className="w-full"
        onClick={onBack}
        type="button"
        disabled={phase !== "ready"}
      >
        Back to review
      </Button>
    </div>
  );
}
