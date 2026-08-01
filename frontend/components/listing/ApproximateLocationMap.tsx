"use client";

import * as React from "react";
import type { ApproximateLocation } from "@/lib/api/listings.js";

interface ApproximateLocationMapProps {
  location: ApproximateLocation;
}

export function ApproximateLocationMap({ location }: ApproximateLocationMapProps) {
  const { city, country, radiusMeters } = location;
  const radiusKm = (radiusMeters / 1000).toFixed(1);

  return (
    <section aria-labelledby="location-heading">
      <h2 id="location-heading" className="mb-4 text-xl font-semibold text-neutral-900">
        Location
      </h2>
      <p className="mb-3 text-sm text-neutral-600">
        {city}, {country} — exact address provided after booking
      </p>
      {/* Static map placeholder; exact coordinates are not exposed pre-booking. */}
      <div
        className="flex h-64 items-center justify-center overflow-hidden rounded-xl bg-neutral-100"
        role="img"
        aria-label={`Approximate map showing ${city}, ${country} with a ${radiusKm} km radius`}
      >
        <div className="text-center text-neutral-400">
          <svg
            className="mx-auto mb-2 h-12 w-12"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0z"
            />
          </svg>
          <p className="text-sm font-medium">{city}, {country}</p>
          <p className="mt-1 text-xs">Approximate area — within {radiusKm} km</p>
        </div>
      </div>
    </section>
  );
}
