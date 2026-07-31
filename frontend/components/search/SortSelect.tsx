"use client";

import * as React from "react";
import { useSearchContext } from "./SearchContext.js";
import type { SortOption } from "@/lib/search/params.js";

const SORT_LABELS: Record<SortOption, string> = {
  recommended: "Recommended",
  price_asc: "Price: Low to High",
  price_desc: "Price: High to Low",
  rating_desc: "Top Rated",
  distance_asc: "Distance",
};

export function SortSelect() {
  const { criteria, dispatch } = useSearchContext();

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="sort-select" className="text-sm text-neutral-600">
        Sort:
      </label>
      <select
        id="sort-select"
        value={criteria.sort}
        onChange={(e) =>
          dispatch({ type: "SET_SORT", payload: e.target.value as SortOption })
        }
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {(Object.keys(SORT_LABELS) as SortOption[]).map((opt) => (
          <option key={opt} value={opt}>
            {SORT_LABELS[opt]}
          </option>
        ))}
      </select>
    </div>
  );
}
