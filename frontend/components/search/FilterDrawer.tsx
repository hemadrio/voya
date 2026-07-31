"use client";

import * as React from "react";
import { FilterPanel } from "./FilterPanel.js";
import type { SearchFacets } from "@/lib/api/search.js";

interface FilterDrawerProps {
  facets?: SearchFacets;
}

export function FilterDrawer({ facets }: FilterDrawerProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h18M7 12h10M11 20h2" />
        </svg>
        Filters
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal
          aria-label="Search filters"
          className="fixed inset-0 z-50 flex"
        >
          {/* Backdrop */}
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close filters"
            onClick={() => setOpen(false)}
          />

          {/* Panel */}
          <div className="relative ml-auto flex h-full w-80 flex-col overflow-y-auto bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
              <h2 className="text-base font-semibold">Filters</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100"
                aria-label="Close filters"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <FilterPanel facets={facets} />
            </div>
            <div className="border-t border-neutral-200 px-4 py-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Show results
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
