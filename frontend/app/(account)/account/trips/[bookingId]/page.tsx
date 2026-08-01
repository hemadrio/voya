/**
 * Booking detail page (WO-069, AC3).
 */

export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getBooking } from "@/lib/api/account.js";
import { ApiError } from "@/lib/api/errors.js";
import { BookingDetailSummary } from "@/components/account/BookingDetailSummary.js";

interface BookingDetailPageProps {
  params: { bookingId: string };
}

export default async function BookingDetailPage({ params }: BookingDetailPageProps) {
  let booking;
  try {
    booking = await getBooking(params.bookingId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  return (
    <>
      <div className="mb-4">
        <a
          href="/account/trips"
          className="text-sm text-brand-600 hover:underline"
          aria-label="Back to My trips"
        >
          ← My trips
        </a>
      </div>
      <BookingDetailSummary booking={booking} />
    </>
  );
}
