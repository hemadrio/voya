"use client";

/**
 * Confirmation client component — polls for final booking status
 * and renders the booking confirmed / pending-confirmation / failed screens.
 *
 * When the wizard times out during polling (AC9), the URL still redirects here.
 * This component resumes polling with fresh backoff.
 */

import { useEffect, useState } from "react";
import { pollBookingStatus } from "@/lib/booking/pollStatus.js";
import type { PollResult } from "@/lib/booking/pollStatus.js";

interface ConfirmationClientProps {
  bookingId: string;
  reference: string | null;
}

type ConfirmationState =
  | { phase: "polling" }
  | { phase: "confirmed"; reference: string }
  | { phase: "failed"; reason?: string }
  | { phase: "pending" };

export function ConfirmationClient({ bookingId, reference }: ConfirmationClientProps) {
  const [state, setState] = useState<ConfirmationState>(
    reference ? { phase: "polling" } : { phase: "pending" },
  );

  useEffect(() => {
    const ctrl = new AbortController();

    pollBookingStatus(bookingId, ctrl.signal, { maxElapsedMs: 90_000 })
      .then((result: PollResult) => {
        if (ctrl.signal.aborted) return;
        if (result.status === "confirmed") {
          setState({ phase: "confirmed", reference: result.reference });
        } else if (result.status === "failed") {
          setState({ phase: "failed", reason: result.failureReason });
        } else {
          // Timeout — show pending UI
          setState({ phase: "pending" });
        }
      })
      .catch(() => setState({ phase: "pending" }));

    return () => ctrl.abort();
  }, [bookingId]);

  if (state.phase === "polling") {
    return (
      <div
        className="flex flex-col items-center gap-4 py-16 text-neutral-600"
        role="status"
        aria-live="polite"
      >
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-brand-600 border-t-transparent"
          aria-hidden="true"
        />
        <p className="text-sm">Confirming your booking…</p>
        <p className="text-xs text-neutral-400">This may take a moment. Please stay on this page.</p>
      </div>
    );
  }

  if (state.phase === "confirmed") {
    return (
      <div>
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-full bg-success-100"
            aria-hidden="true"
          >
            <svg className="h-7 w-7 text-success-600" viewBox="0 0 24 24" fill="none">
              <path
                d="M5 12l4.5 4.5L19 7"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-neutral-900">Booking confirmed!</h1>
          <p className="text-sm text-neutral-500">
            A confirmation email is on its way to you.
          </p>
        </div>

        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm">
          <dl className="space-y-2">
            <div className="flex justify-between">
              <dt className="text-neutral-500">Booking reference</dt>
              <dd className="font-mono font-semibold text-neutral-900">{state.reference}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-neutral-500">Booking ID</dt>
              <dd className="font-mono text-xs text-neutral-600">{bookingId}</dd>
            </div>
          </dl>
        </div>

        <div className="mt-6 flex flex-col gap-3">
          <a
            href={`/bookings/${bookingId}`}
            className="block w-full rounded-md bg-brand-600 px-4 py-2.5 text-center text-sm font-semibold text-white hover:bg-brand-700"
          >
            View booking details
          </a>
          <a
            href="/"
            className="block w-full rounded-md border border-neutral-300 px-4 py-2.5 text-center text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Return to home
          </a>
        </div>
      </div>
    );
  }

  if (state.phase === "failed") {
    return (
      <div>
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-full bg-error-100"
            aria-hidden="true"
          >
            <svg className="h-7 w-7 text-error-600" viewBox="0 0 24 24" fill="none">
              <path
                d="M6 18L18 6M6 6l12 12"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-neutral-900">Booking failed</h1>
          {state.reason && (
            <p className="text-sm text-error-600">{state.reason}</p>
          )}
        </div>
        <div className="flex flex-col gap-3">
          <a
            href="/checkout"
            className="block w-full rounded-md bg-brand-600 px-4 py-2.5 text-center text-sm font-semibold text-white hover:bg-brand-700"
          >
            Try again
          </a>
          <a
            href="/"
            className="block w-full rounded-md border border-neutral-300 px-4 py-2.5 text-center text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Return to home
          </a>
        </div>
      </div>
    );
  }

  // phase === "pending"
  return (
    <div>
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <div
          className="flex h-14 w-14 items-center justify-center rounded-full bg-warning-100"
          aria-hidden="true"
        >
          <svg className="h-7 w-7 text-warning-600" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 8v4m0 4h.01M12 2a10 10 0 100 20A10 10 0 0012 2z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-neutral-900">Booking pending</h1>
        <p className="text-sm text-neutral-600">
          Your booking is being processed. We'll send you a confirmation email
          once it's finalised.
        </p>
      </div>

      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm">
        <dl className="space-y-2">
          <div className="flex justify-between">
            <dt className="text-neutral-500">Booking ID</dt>
            <dd className="font-mono text-xs text-neutral-600">{bookingId}</dd>
          </div>
          {reference && (
            <div className="flex justify-between">
              <dt className="text-neutral-500">Reference</dt>
              <dd className="font-mono font-semibold text-neutral-900">{reference}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="mt-6">
        <a
          href="/"
          className="block w-full rounded-md border border-neutral-300 px-4 py-2.5 text-center text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Return to home
        </a>
      </div>
    </div>
  );
}
