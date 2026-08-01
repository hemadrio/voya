"use client";

import * as React from "react";
import type { ListingAmenity } from "@/lib/api/listings.js";
import { Modal } from "@/components/ui/Modal.js";

interface AmenitiesGridProps {
  amenities: ListingAmenity[];
  threshold?: number;
}

const AMENITY_ICONS: Record<string, string> = {
  wifi: "📶",
  parking: "🅿️",
  pool: "🏊",
  gym: "🏋️",
  kitchen: "🍳",
  washer: "🫧",
  dryer: "🌀",
  air_conditioning: "❄️",
  heating: "🔥",
  tv: "📺",
  workspace: "💼",
  pets_allowed: "🐾",
  smoking_allowed: "🚬",
  no_smoking: "🚭",
  elevator: "🛗",
  ev_charger: "⚡",
};

function AmenityItem({ amenity }: { amenity: ListingAmenity }) {
  const icon = AMENITY_ICONS[amenity.code] ?? "✓";
  return (
    <li className="flex items-center gap-2 text-sm text-neutral-700">
      <span aria-hidden="true">{icon}</span>
      <span>{amenity.label}</span>
    </li>
  );
}

export function AmenitiesGrid({ amenities, threshold = 10 }: AmenitiesGridProps) {
  const [showAll, setShowAll] = React.useState(false);
  const visible = amenities.slice(0, threshold);
  const hasMore = amenities.length > threshold;

  return (
    <section aria-labelledby="amenities-heading">
      <h2 id="amenities-heading" className="mb-4 text-xl font-semibold text-neutral-900">
        Amenities
      </h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {visible.map((a) => (
          <AmenityItem key={a.code} amenity={a} />
        ))}
      </ul>
      {hasMore && (
        <button
          type="button"
          className="mt-4 text-sm font-semibold underline"
          onClick={() => setShowAll(true)}
        >
          Show all {amenities.length} amenities
        </button>
      )}

      <Modal
        open={showAll}
        onOpenChange={setShowAll}
        title={`All amenities (${amenities.length})`}
      >
        <ul className="grid grid-cols-2 gap-3 max-h-96 overflow-y-auto">
          {amenities.map((a) => (
            <AmenityItem key={a.code} amenity={a} />
          ))}
        </ul>
      </Modal>
    </section>
  );
}
