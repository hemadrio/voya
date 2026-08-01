"use client";

import * as React from "react";

interface MobileReserveBarProps {
  currency: string;
  listingSlug: string;
}

export function MobileReserveBar({ currency, listingSlug }: MobileReserveBarProps) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-between border-t border-neutral-200 bg-white px-4 py-3 shadow-lg sm:hidden">
      <div className="text-sm text-neutral-600">
        <span className="font-semibold text-neutral-900">{currency}</span> / night
      </div>
      <a
        href={`#booking-widget`}
        className="rounded-xl bg-rose-600 px-6 py-3 text-sm font-semibold text-white hover:bg-rose-700"
        aria-label="Check availability for this listing"
      >
        Check availability
      </a>
    </div>
  );
}
