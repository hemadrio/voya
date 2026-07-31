"use client";

import * as React from "react";
import { FilterPanel } from "./FilterPanel.js";
import type { SearchFacets } from "@/lib/api/search.js";

interface FilterRailProps {
  facets?: SearchFacets;
}

export function FilterRail({ facets }: FilterRailProps) {
  return (
    <div className="hidden w-64 shrink-0 lg:block">
      <FilterPanel facets={facets} className="sticky top-4" />
    </div>
  );
}
