"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  filterReducer,
  buildSearchParams,
} from "@/lib/search/params.js";
import type { SearchCriteria, FilterAction } from "@/lib/search/params.js";

const DEBOUNCE_MS = 300;

export interface UseSearchFiltersReturn {
  criteria: SearchCriteria;
  dispatch: React.Dispatch<FilterAction>;
  isPending: boolean;
}

export function useSearchFilters(initialCriteria: SearchCriteria): UseSearchFiltersReturn {
  const router = useRouter();
  const [criteria, dispatch] = React.useReducer(filterReducer, initialCriteria);
  const [isPending, startTransition] = React.useTransition();

  // Debounce: cancel the previous timer before scheduling a new URL update
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      const qs = buildSearchParams(criteria).toString();
      startTransition(() => {
        router.replace(`/search${qs ? `?${qs}` : ""}`, { scroll: false });
      });
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [criteria, router]);

  return { criteria, dispatch, isPending };
}
