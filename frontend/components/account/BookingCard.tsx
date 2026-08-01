"use client";

/**
 * BookingCard — compact booking list item (WO-069, AC2).
 */

import { cn } from "@/lib/utils.js";
import { DISPLAY_STATUS_LABELS } from "@/lib/bookings/status.js";
import type { BookingListItem } from "@/lib/api/account.js";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency", currency, minimumFractionDigits: 0,
  }).format(amount);
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-warning-100 text-warning-700",
  confirmed: "bg-success-100 text-success-700",
  pending_modification: "bg-blue-100 text-blue-700",
  cancelled: "bg-neutral-100 text-neutral-500",
  failed: "bg-error-100 text-error-700",
};

interface BookingCardProps {
  booking: BookingListItem;
}

export function BookingCard({ booking }: BookingCardProps) {
  const guests = [
    booking.guests.adults > 0 && `${booking.guests.adults} adult${booking.guests.adults !== 1 ? "s" : ""}`,
    booking.guests.children > 0 && `${booking.guests.children} child${booking.guests.children !== 1 ? "ren" : ""}`,
    booking.guests.infants > 0 && `${booking.guests.infants} infant${booking.guests.infants !== 1 ? "s" : ""}`,
  ].filter(Boolean).join(", ");

  return (
    <a
      href={`/account/trips/${booking.bookingId}`}
      className="block rounded-lg border border-neutral-200 bg-white p-4 transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      aria-label={`${booking.listing.title} — ${formatDate(booking.checkIn)} to ${formatDate(booking.checkOut)}`}
    >
      <div className="flex gap-4">
        {/* Hero image */}
        <div className="h-20 w-28 flex-shrink-0 overflow-hidden rounded-md bg-neutral-100">
          {booking.listing.heroImage && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={booking.listing.heroImage}
              alt=""
              className="h-full w-full object-cover"
            />
          )}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate text-sm font-semibold text-neutral-900">
              {booking.listing.title}
            </h3>
            <span
              className={cn(
                "flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                STATUS_COLORS[booking.status] ?? "bg-neutral-100 text-neutral-500",
              )}
            >
              {DISPLAY_STATUS_LABELS[booking.status]}
            </span>
          </div>

          <p className="mt-0.5 text-xs text-neutral-500">{booking.listing.location}</p>

          <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-neutral-600">
            <div>
              <dt className="sr-only">Dates</dt>
              <dd>{formatDate(booking.checkIn)} – {formatDate(booking.checkOut)}</dd>
            </div>
            {guests && (
              <div>
                <dt className="sr-only">Guests</dt>
                <dd>{guests}</dd>
              </div>
            )}
            <div>
              <dt className="sr-only">Total</dt>
              <dd className="font-medium">
                {formatAmount(booking.total.amount, booking.total.currency)}
              </dd>
            </div>
          </dl>

          <p className="mt-1 text-xs text-neutral-400">Ref: {booking.reference}</p>
        </div>
      </div>
    </a>
  );
}
