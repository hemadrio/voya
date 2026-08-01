/**
 * Trips dashboard — groups bookings into upcoming, in-progress, past, cancelled (WO-069, AC2).
 */

export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { listBookings } from "@/lib/api/account.js";
import type { BookingListItem } from "@/lib/api/account.js";
import { deriveTab } from "@/lib/bookings/status.js";
import type { TripTab } from "@/lib/bookings/status.js";
import { TripTabs } from "@/components/account/TripTabs.js";

async function loadAllBookings(): Promise<Partial<Record<TripTab, BookingListItem[]>>> {
  try {
    // Fetch first page of all bookings and group client-side by derived tab
    const result = await listBookings({ pageSize: 50 });
    const groups: Partial<Record<TripTab, BookingListItem[]>> = {};
    for (const item of result.items) {
      const tab = deriveTab({
        status: item.status,
        checkIn: item.checkIn,
        checkOut: item.checkOut,
        timezone: item.timezone,
      });
      if (!groups[tab]) groups[tab] = [];
      groups[tab]!.push(item);
    }
    return groups;
  } catch {
    return {};
  }
}

export default async function TripsPage() {
  const bookingsByTab = await loadAllBookings();

  return (
    <>
      <h1 className="mb-4 text-xl font-bold text-neutral-900">My trips</h1>
      <Suspense fallback={<div className="py-4 text-sm text-neutral-500" role="status">Loading trips…</div>}>
        <TripTabs bookingsByTab={bookingsByTab} />
      </Suspense>
    </>
  );
}
