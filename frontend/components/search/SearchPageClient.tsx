"use client";

import * as React from "react";
import { SearchContext } from "./SearchContext.js";
import { useSearchFilters } from "./useSearchFilters.js";
import { SearchBar } from "./SearchBar.js";
import { FilterRail } from "./FilterRail.js";
import { FilterDrawer } from "./FilterDrawer.js";
import { ActiveFilterChips } from "./ActiveFilterChips.js";
import { SortSelect } from "./SortSelect.js";
import { ResultList } from "./ResultList.js";
import { ResultsMap } from "./ResultsMap.js";
import { fetchSearch } from "@/lib/api/search.js";
import type { SearchResponse } from "@/lib/api/search.js";
import type { SearchCriteria } from "@/lib/search/params.js";

interface SearchPageClientProps {
  initialCriteria: SearchCriteria;
  initialData: SearchResponse | null;
}

export function SearchPageClient({ initialCriteria, initialData }: SearchPageClientProps) {
  const { criteria, dispatch, isPending } = useSearchFilters(initialCriteria);
  const [data, setData] = React.useState<SearchResponse | null>(initialData);
  const [error, setError] = React.useState<Error | null>(null);
  const [isFetching, setIsFetching] = React.useState(false);
  const [showMap, setShowMap] = React.useState(false);
  const [hoveredItemId, setHoveredItemId] = React.useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = React.useState<string | null>(null);

  // Refetch whenever criteria change (skip the very first render if we have initialData)
  const isFirstRender = React.useRef(true);

  React.useEffect(() => {
    // Skip first render when initialData covers the initial criteria
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    const controller = new AbortController();
    setIsFetching(true);
    setError(null);

    fetchSearch(criteria, controller.signal)
      .then((result) => {
        // Discard if a newer request has already superseded this one
        if (!controller.signal.aborted) {
          setData(result);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsFetching(false);
      });

    return () => controller.abort();
  }, [criteria]);

  const totalItems = data?.totalItems ?? 0;
  const pending = isPending || isFetching;

  return (
    <SearchContext.Provider
      value={{
        criteria,
        dispatch,
        data,
        isPending: pending,
        error,
        hoveredItemId,
        setHoveredItemId,
        selectedItemId,
        setSelectedItemId,
      }}
    >
      <div className="min-h-screen bg-neutral-50">
        {/* Search bar */}
        <header className="sticky top-0 z-30 border-b border-neutral-200 bg-white px-4 py-3 shadow-sm">
          <div className="mx-auto max-w-7xl">
            <SearchBar initialCriteria={criteria} />
          </div>
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6">
          {/* Toolbar */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <FilterDrawer facets={data?.facets} />
              <span
                className="text-sm text-neutral-600"
                aria-live="polite"
                aria-atomic
              >
                {pending ? "Searching…" : `${totalItems.toLocaleString()} result${totalItems !== 1 ? "s" : ""}`}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <SortSelect />
              <button
                type="button"
                onClick={() => setShowMap((v) => !v)}
                aria-pressed={showMap}
                className="hidden items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 lg:flex"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                </svg>
                {showMap ? "Hide map" : "Show map"}
              </button>
            </div>
          </div>

          {/* Active filter chips */}
          <ActiveFilterChips />

          {/* Error state */}
          {error && (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              Failed to load results.{" "}
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  // Re-trigger by re-mounting (nudge effect)
                  isFirstRender.current = false;
                  fetchSearch(criteria)
                    .then(setData)
                    .catch((err: unknown) =>
                      setError(err instanceof Error ? err : new Error(String(err))),
                    );
                }}
                className="font-medium underline hover:text-red-800"
              >
                Retry
              </button>
            </div>
          )}

          {/* Content layout */}
          <div className={`mt-4 flex gap-6 ${showMap ? "lg:flex-row" : ""}`}>
            {/* Filter rail (desktop) */}
            <FilterRail facets={data?.facets} />

            {/* Results */}
            <div className="flex-1 min-w-0">
              <React.Suspense fallback={null}>
                <ResultList totalItems={totalItems} />
              </React.Suspense>
            </div>

            {/* Map (desktop toggle) */}
            {showMap && (
              <div className="hidden h-[calc(100vh-12rem)] w-[400px] shrink-0 lg:block">
                <div className="sticky top-28 h-full">
                  <ResultsMap className="h-full" />
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </SearchContext.Provider>
  );
}
