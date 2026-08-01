import * as React from "react";
import type { ListingDetail } from "@/lib/api/listings.js";

interface ListingHeaderProps {
  listing: ListingDetail;
}

export function ListingHeader({ listing }: ListingHeaderProps) {
  const { rating } = listing;

  return (
    <header className="mb-4">
      <h1 className="text-2xl font-bold text-neutral-900 sm:text-3xl">{listing.title}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-600">
        {rating.count > 0 && (
          <span className="flex items-center gap-1">
            <span aria-hidden="true">★</span>
            <span>
              <strong>{rating.average.toFixed(2)}</strong>
              <span className="ml-1">({rating.count} reviews)</span>
            </span>
          </span>
        )}
        <span>
          {listing.approximateLocation.city}, {listing.approximateLocation.country}
        </span>
        <span className="capitalize">{listing.type.replace(/_/g, " ")}</span>
      </div>
    </header>
  );
}
