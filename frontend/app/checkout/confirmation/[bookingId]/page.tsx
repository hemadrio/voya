/**
 * Booking confirmation page (WO-068, AC10).
 *
 * Rendered after successful booking creation.
 * Shows booking reference, dates, guests, total, cancellation deadline.
 * Handles pending-confirmation variant when polling times out (AC9).
 *
 * bookingId is passed via dynamic route segment.
 * ref (booking reference) is passed via search param.
 */

export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { Suspense } from "react";
import { ConfirmationClient } from "./ConfirmationClient.js";

export const metadata: Metadata = {
  title: "Booking confirmed — Checkout",
  robots: { index: false, follow: false },
};

interface ConfirmationPageProps {
  params: { bookingId: string };
  searchParams: { ref?: string };
}

export default function ConfirmationPage({ params, searchParams }: ConfirmationPageProps) {
  return (
    <main className="mx-auto max-w-lg px-4 py-8">
      <Suspense fallback={
        <div
          className="flex flex-col items-center gap-3 py-16 text-sm text-neutral-500"
          role="status"
          aria-live="polite"
        >
          <div
            className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent"
            aria-hidden="true"
          />
          Loading confirmation…
        </div>
      }>
        <ConfirmationClient
          bookingId={params.bookingId}
          reference={searchParams.ref ?? null}
        />
      </Suspense>
    </main>
  );
}
