"use client";

/**
 * BookingDetailSummary — full booking detail view (WO-069, AC3).
 *
 * Shows: reference, listing, dates, guests, itemized charges, payment info,
 * cancellation policy, cancellation deadline with countdown, download actions.
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils.js";
import {
  DISPLAY_STATUS_LABELS,
  isDeadlineImminent,
  isDeadlinePassed,
  formatCountdown,
  msUntilDeadline,
} from "@/lib/bookings/status.js";
import { downloadIcs } from "@/lib/calendar/ics.js";
import { CancellationDialog } from "./CancellationDialog.js";
import { ModificationDialog } from "./ModificationDialog.js";
import type { BookingDetail, CancellationResult, ModificationResult } from "@/lib/api/account.js";

function fmt(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: 2 }).format(amount);
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

interface BookingDetailSummaryProps {
  booking: BookingDetail;
  onCancelled?: (result: CancellationResult) => void;
  onModified?: (result: ModificationResult) => void;
}

export function BookingDetailSummary({ booking, onCancelled, onModified }: BookingDetailSummaryProps) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [modifyOpen, setModifyOpen] = useState(false);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<string | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const deadlineImminent = isDeadlineImminent(booking.cancellationDeadline);
  const deadlinePassed = isDeadlinePassed(booking.cancellationDeadline);

  // Countdown timer — only when within 48 hours; coarse update every minute
  useEffect(() => {
    if (!deadlineImminent) return;
    const update = () => setCountdown(formatCountdown(msUntilDeadline(booking.cancellationDeadline)));
    update();
    countdownRef.current = setInterval(update, 60_000);
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [deadlineImminent, booking.cancellationDeadline]);

  function handleDownloadIcs() {
    downloadIcs({
      reference: booking.reference,
      title: booking.listing.title,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      timezone: booking.timezone,
      location: booking.listing.location,
    });
  }

  async function handleReceiptDownload(receiptUrl: string) {
    try {
      const res = await fetch(receiptUrl);
      if (!res.ok) throw new Error("Receipt not available");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `receipt-${booking.reference}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      alert("Receipt is not available yet. Please try again shortly.");
    }
  }

  function handleCancelled(result: CancellationResult) {
    setConflictNotice(null);
    onCancelled?.(result);
  }

  function handleConflict(code: "ALREADY_CANCELLED" | "DEADLINE_PASSED") {
    setConflictNotice(
      code === "ALREADY_CANCELLED"
        ? "This booking has already been cancelled."
        : "The cancellation deadline has passed. Please contact support.",
    );
  }

  const guests = [
    booking.guests.adults > 0 && `${booking.guests.adults} adult${booking.guests.adults !== 1 ? "s" : ""}`,
    booking.guests.children > 0 && `${booking.guests.children} child${booking.guests.children !== 1 ? "ren" : ""}`,
    booking.guests.infants > 0 && `${booking.guests.infants} infant${booking.guests.infants !== 1 ? "s" : ""}`,
  ].filter(Boolean).join(", ");

  return (
    <div className="space-y-6">
      {/* Status + reference */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-neutral-900">{booking.listing.title}</h1>
          <p className="mt-0.5 text-sm text-neutral-500">{booking.listing.location}</p>
        </div>
        <span className="rounded-full bg-neutral-100 px-3 py-1 text-sm font-medium text-neutral-700">
          {DISPLAY_STATUS_LABELS[booking.status]}
        </span>
      </div>

      {conflictNotice && (
        <div role="alert" className="rounded-md border border-warning-300 bg-warning-50 p-3 text-sm text-warning-700">
          {conflictNotice}
        </div>
      )}

      {/* Core details */}
      <section aria-labelledby="booking-dates">
        <h2 id="booking-dates" className="mb-2 text-sm font-semibold text-neutral-700">Stay details</h2>
        <dl className="grid grid-cols-2 gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm">
          <div><dt className="text-neutral-500">Reference</dt><dd className="font-mono font-semibold">{booking.reference}</dd></div>
          <div><dt className="text-neutral-500">Guests</dt><dd>{guests || "—"}</dd></div>
          <div><dt className="text-neutral-500">Check-in</dt><dd className="font-medium">{fmtDate(booking.checkIn)}</dd></div>
          <div><dt className="text-neutral-500">Check-out</dt><dd className="font-medium">{fmtDate(booking.checkOut)}</dd></div>
        </dl>
      </section>

      {/* Cancellation deadline */}
      {booking.status === "confirmed" && (
        <section aria-labelledby="cancel-deadline">
          <h2 id="cancel-deadline" className="mb-2 text-sm font-semibold text-neutral-700">Cancellation deadline</h2>
          <div
            className={cn(
              "rounded-lg border p-3 text-sm",
              deadlinePassed
                ? "border-error-300 bg-error-50"
                : deadlineImminent
                  ? "border-warning-300 bg-warning-50"
                  : "border-neutral-200 bg-neutral-50",
            )}
          >
            <p className={deadlinePassed ? "text-error-700" : deadlineImminent ? "text-warning-700" : "text-neutral-600"}>
              {deadlinePassed
                ? "Free cancellation deadline has passed."
                : `Free cancellation until ${fmtDate(booking.cancellationDeadline)}`}
            </p>
            {/* aria-live countdown within 48 hours */}
            {countdown && !deadlinePassed && (
              <p
                className="mt-1 text-xs font-medium text-warning-700"
                aria-live="polite"
                aria-atomic="true"
              >
                {countdown}
              </p>
            )}
          </div>
        </section>
      )}

      {/* Itemized charges */}
      <section aria-labelledby="charges-heading">
        <h2 id="charges-heading" className="mb-2 text-sm font-semibold text-neutral-700">Charges</h2>
        <dl className="rounded-lg border border-neutral-200 p-4 text-sm space-y-2">
          {booking.lineItems.map((item) => (
            <div key={item.code} className="flex justify-between">
              <dt className="text-neutral-600">{item.label}</dt>
              <dd>{fmt(item.amount, item.currency)}</dd>
            </div>
          ))}
          <div className="flex justify-between border-t border-neutral-200 pt-2">
            <dt className="font-semibold text-neutral-900">Total</dt>
            <dd className="font-bold text-neutral-900">{fmt(booking.total.amount, booking.total.currency)}</dd>
          </div>
        </dl>
      </section>

      {/* Payment info */}
      {booking.payments.length > 0 && (
        <section aria-labelledby="payment-heading">
          <h2 id="payment-heading" className="mb-2 text-sm font-semibold text-neutral-700">Payment</h2>
          <div className="space-y-2">
            {booking.payments.map((payment) => (
              <div key={payment.id} className="flex items-center justify-between rounded-lg border border-neutral-200 p-3 text-sm">
                <div>
                  <span className="font-medium capitalize">{payment.method}</span>
                  {payment.last4 && (
                    <span className="ml-1.5 text-neutral-500">ending ···· {payment.last4}</span>
                  )}
                  <p className="text-xs text-neutral-400">
                    {new Date(payment.capturedAt).toLocaleDateString("en-GB")}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-medium">{fmt(payment.amount, booking.total.currency)}</span>
                  {payment.receiptUrl && (
                    <button
                      type="button"
                      onClick={() => handleReceiptDownload(payment.receiptUrl)}
                      className="text-xs text-brand-600 hover:underline"
                    >
                      Receipt
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Cancellation policies */}
      {booking.policies.length > 0 && (
        <section aria-labelledby="policy-heading">
          <h2 id="policy-heading" className="mb-2 text-sm font-semibold text-neutral-700">Policies</h2>
          <div className="space-y-2 text-sm">
            {booking.policies.map((policy, i) => (
              <div key={i} className="rounded-lg border border-neutral-200 p-3">
                <p className="font-medium text-neutral-800">{policy.label}</p>
                <p className="mt-0.5 text-neutral-600">{policy.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Host contact */}
      {booking.host && (
        <section>
          <p className="text-sm text-neutral-500">
            Questions? Your host <strong>{booking.host.name}</strong> is available from{" "}
            {booking.host.contactAvailableFrom}. Use the messaging section in your booking detail.
          </p>
        </section>
      )}

      {/* Actions */}
      <section aria-label="Booking actions" className="flex flex-wrap gap-3">
        {booking.status === "confirmed" && (
          <button
            type="button"
            onClick={handleDownloadIcs}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Add to calendar
          </button>
        )}
        {booking.voucherUrl && (
          <a
            href={booking.voucherUrl}
            download
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Download voucher
          </a>
        )}
        {booking.canModify && (
          <button
            type="button"
            onClick={() => setModifyOpen(true)}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Modify booking
          </button>
        )}
        {booking.canCancel && (
          <button
            type="button"
            onClick={() => setCancelOpen(true)}
            className="rounded-md border border-error-300 px-3 py-2 text-sm font-medium text-error-600 hover:bg-error-50"
          >
            Cancel booking
          </button>
        )}
        {booking.status === "pending" && (
          <p className="text-sm text-neutral-500">
            Your booking is awaiting confirmation. Modification and cancellation will be available once confirmed.
          </p>
        )}
      </section>

      {/* Dialogs */}
      <CancellationDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        bookingId={booking.bookingId}
        onCancelled={handleCancelled}
        onConflict={handleConflict}
      />
      <ModificationDialog
        open={modifyOpen}
        onOpenChange={setModifyOpen}
        bookingId={booking.bookingId}
        currentCheckIn={booking.checkIn}
        currentCheckOut={booking.checkOut}
        currentAdults={booking.guests.adults}
        onModified={(result) => { setModifyOpen(false); onModified?.(result); }}
      />
    </div>
  );
}
