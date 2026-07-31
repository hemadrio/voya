"use client";

import * as React from "react";
import type { SearchCriteria, FilterAction } from "@/lib/search/params.js";
import type { SearchResponse } from "@/lib/api/search.js";

export interface SearchContextValue {
  criteria: SearchCriteria;
  dispatch: React.Dispatch<FilterAction>;
  data: SearchResponse | null;
  isPending: boolean;
  error: Error | null;
  /** Bidirectional hover sync between cards and map pins */
  hoveredItemId: string | null;
  setHoveredItemId: (id: string | null) => void;
  /** Bidirectional selection sync */
  selectedItemId: string | null;
  setSelectedItemId: (id: string | null) => void;
}

export const SearchContext = React.createContext<SearchContextValue | null>(null);

export function useSearchContext(): SearchContextValue {
  const ctx = React.useContext(SearchContext);
  if (ctx === null) {
    throw new Error("useSearchContext must be used within a SearchContext.Provider");
  }
  return ctx;
}
