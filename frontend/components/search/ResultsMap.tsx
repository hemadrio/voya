"use client";

/**
 * ResultsMap — code-split map view for the search results page.
 *
 * Dynamically imported with ssr:false to keep the map implementation out of
 * the initial JavaScript bundle for the search route (WO-066 constraint).
 */

import * as React from "react";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/Skeleton.js";

const ResultsMapInner = dynamic(
  () => import("./ResultsMapInner.js").then((m) => ({ default: m.ResultsMapInner })),
  {
    ssr: false,
    loading: () => (
      <Skeleton variant="rectangular" className="h-full w-full rounded-xl" aria-label="Loading map" />
    ),
  },
);

interface ResultsMapProps {
  className?: string;
}

export function ResultsMap({ className }: ResultsMapProps) {
  const [mapError, setMapError] = React.useState<string | null>(null);

  if (mapError) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-neutral-200 bg-neutral-50 text-sm text-neutral-500">
        <p>Map unavailable — <button type="button" className="underline" onClick={() => setMapError(null)}>retry</button></p>
      </div>
    );
  }

  return (
    <div className={className}>
      <React.Suspense
        fallback={<Skeleton variant="rectangular" className="h-full w-full rounded-xl" aria-label="Loading map" />}
      >
        <ResultsMapInner />
      </React.Suspense>
    </div>
  );
}
