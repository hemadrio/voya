import { ResultListSkeleton } from "@/components/search/ResultList.js";
import { Skeleton } from "@/components/ui/Skeleton.js";

/**
 * Next.js streaming loading UI — rendered while the search page suspends.
 * Matches the final layout to prevent cumulative layout shift.
 */
export default function SearchLoading() {
  return (
    <div className="min-h-screen bg-neutral-50">
      {/* Search bar skeleton */}
      <header className="sticky top-0 z-30 border-b border-neutral-200 bg-white px-4 py-3 shadow-sm">
        <div className="mx-auto max-w-7xl">
          <Skeleton variant="rectangular" className="h-16 w-full rounded-xl" aria-label="Loading search bar" />
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        {/* Toolbar skeleton */}
        <div className="mb-4 flex items-center gap-3">
          <Skeleton variant="rectangular" className="h-9 w-24 rounded-md" />
          <Skeleton variant="text" className="h-4 w-32" />
        </div>

        <div className="mt-4 flex gap-6">
          {/* Filter rail skeleton (desktop only) */}
          <div className="hidden w-64 shrink-0 lg:block">
            <div className="flex flex-col gap-4">
              <Skeleton variant="rectangular" className="h-40 w-full rounded-lg" />
              <Skeleton variant="rectangular" className="h-32 w-full rounded-lg" />
              <Skeleton variant="rectangular" className="h-48 w-full rounded-lg" />
            </div>
          </div>

          {/* Results skeleton */}
          <div className="flex-1">
            <ResultListSkeleton />
          </div>
        </div>
      </main>
    </div>
  );
}
