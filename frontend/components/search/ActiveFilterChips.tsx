"use client";

import * as React from "react";
import { useSearchContext } from "./SearchContext.js";
import { getActiveFilters } from "@/lib/search/params.js";

export function ActiveFilterChips() {
  const { criteria, dispatch } = useSearchContext();
  const filters = getActiveFilters(criteria);

  if (filters.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Active filters">
      {filters.map((f) => (
        <button
          key={f.key}
          type="button"
          onClick={() => dispatch(f.action)}
          className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
          aria-label={`Remove filter: ${f.label}`}
        >
          {f.label}
          <span aria-hidden className="ml-0.5 text-blue-400">×</span>
        </button>
      ))}

      <button
        type="button"
        onClick={() => dispatch({ type: "CLEAR_FILTERS" })}
        className="text-xs text-neutral-500 underline hover:text-neutral-700"
      >
        Clear all
      </button>
    </div>
  );
}
