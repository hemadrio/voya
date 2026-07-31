"use client";

import * as React from "react";
import { useSearchContext } from "./SearchContext.js";
import { getActiveFilters } from "@/lib/search/params.js";

interface EmptyResultsProps {
  totalItems: number;
}

export function EmptyResults({ totalItems }: EmptyResultsProps) {
  const { criteria, dispatch } = useSearchContext();
  const activeFilters = getActiveFilters(criteria);

  if (totalItems > 0) return null;

  // Pick the most restrictive filter to suggest relaxing
  // Priority: amenities (most specific) > type > rating > free cancellation > price
  const mostRestrictive = activeFilters.find((f) => f.key.startsWith("amenity:"))
    ?? activeFilters.find((f) => f.key === "type")
    ?? activeFilters.find((f) => f.key === "rating")
    ?? activeFilters.find((f) => f.key === "freeCancellation")
    ?? activeFilters.find((f) => f.key === "price")
    ?? activeFilters[0];

  return (
    <div
      className="flex flex-col items-center justify-center rounded-xl border border-neutral-200 bg-white px-8 py-16 text-center"
      role="status"
      aria-live="polite"
    >
      <div className="mb-4 text-5xl" aria-hidden>
        🔍
      </div>
      <h2 className="mb-2 text-xl font-semibold text-neutral-900">No results found</h2>
      <p className="mb-6 max-w-sm text-sm text-neutral-500">
        {activeFilters.length > 0
          ? "Your current filters didn't match any properties. Try removing a filter or broadening your search."
          : "No properties match your search. Try a different destination or dates."}
      </p>

      {mostRestrictive && (
        <button
          type="button"
          onClick={() => dispatch(mostRestrictive.action)}
          className="mb-3 rounded-md border border-blue-600 px-4 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50"
        >
          Remove &ldquo;{mostRestrictive.label}&rdquo; filter
        </button>
      )}

      {activeFilters.length > 1 && (
        <button
          type="button"
          onClick={() => dispatch({ type: "CLEAR_FILTERS" })}
          className="text-sm text-neutral-500 underline hover:text-neutral-700"
        >
          Clear all filters
        </button>
      )}
    </div>
  );
}
