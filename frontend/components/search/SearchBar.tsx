"use client";

import * as React from "react";
import { cn } from "@/lib/utils.js";
import type { SearchCriteria } from "@/lib/search/params.js";
import { buildSearchParams } from "@/lib/search/params.js";
import { useRouter } from "next/navigation";

interface SearchBarProps {
  initialCriteria: SearchCriteria;
  className?: string;
}

export function SearchBar({ initialCriteria, className }: SearchBarProps) {
  const router = useRouter();
  const [destination, setDestination] = React.useState(initialCriteria.destination);
  const [checkIn, setCheckIn] = React.useState(initialCriteria.checkIn ?? "");
  const [checkOut, setCheckOut] = React.useState(initialCriteria.checkOut ?? "");
  const [guests, setGuests] = React.useState(initialCriteria.guests);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const updated: SearchCriteria = {
      ...initialCriteria,
      destination,
      checkIn: checkIn || undefined,
      checkOut: checkOut || undefined,
      guests,
      page: 1,
    };
    const qs = buildSearchParams(updated).toString();
    router.push(`/search${qs ? `?${qs}` : ""}`);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn("flex flex-wrap gap-2 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm", className)}
      role="search"
      aria-label="Search accommodation"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor="sb-destination" className="text-xs font-medium text-neutral-500">
          Destination
        </label>
        <input
          id="sb-destination"
          type="text"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="Where are you going?"
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="sb-checkin" className="text-xs font-medium text-neutral-500">
          Check-in
        </label>
        <input
          id="sb-checkin"
          type="date"
          value={checkIn}
          onChange={(e) => setCheckIn(e.target.value)}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="sb-checkout" className="text-xs font-medium text-neutral-500">
          Check-out
        </label>
        <input
          id="sb-checkout"
          type="date"
          value={checkOut}
          min={checkIn || undefined}
          onChange={(e) => setCheckOut(e.target.value)}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="sb-guests" className="text-xs font-medium text-neutral-500">
          Guests
        </label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Decrease guests"
            onClick={() => setGuests((g) => Math.max(1, g - 1))}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-neutral-300 text-neutral-600 hover:bg-neutral-50"
          >
            –
          </button>
          <input
            id="sb-guests"
            type="number"
            min={1}
            max={20}
            value={guests}
            onChange={(e) => setGuests(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1)))}
            className="w-12 rounded-md border border-neutral-300 px-2 py-2 text-center text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="button"
            aria-label="Increase guests"
            onClick={() => setGuests((g) => Math.min(20, g + 1))}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-neutral-300 text-neutral-600 hover:bg-neutral-50"
          >
            +
          </button>
        </div>
      </div>

      <div className="flex items-end">
        <button
          type="submit"
          className="rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          Search
        </button>
      </div>
    </form>
  );
}
