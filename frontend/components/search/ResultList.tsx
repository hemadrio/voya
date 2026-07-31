"use client";

import * as React from "react";
import { ResultCard } from "./ResultCard.js";
import { EmptyResults } from "./EmptyResults.js";
import { Skeleton } from "@/components/ui/Skeleton.js";
import { useSearchContext } from "./SearchContext.js";

interface ResultListProps {
  totalItems: number;
}

export function ResultList({ totalItems }: ResultListProps) {
  const { data, isPending, criteria, dispatch } = useSearchContext();

  const items = data?.items ?? [];
  const totalPages = data?.totalPages ?? 1;

  if (isPending && items.length === 0) {
    return <ResultListSkeleton />;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Result count announcement */}
      <div aria-live="polite" aria-atomic className="sr-only">
        {totalItems} results found
      </div>

      {isPending && (
        <div className="pointer-events-none absolute inset-0 z-10 rounded-xl bg-white/60" aria-hidden />
      )}

      {totalItems === 0 ? (
        <EmptyResults totalItems={totalItems} />
      ) : (
        <div
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2"
          role="list"
          aria-label="Search results"
        >
          {items.map((item, idx) => (
            <div key={item.id} role="listitem">
              <ResultCard item={item} priority={idx < 2} />
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <nav aria-label="Results pagination" className="mt-4 flex items-center justify-center gap-2">
          <button
            type="button"
            disabled={criteria.page <= 1}
            onClick={() => dispatch({ type: "SET_PAGE", payload: criteria.page - 1 })}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-neutral-50"
            aria-label="Previous page"
          >
            ← Prev
          </button>

          {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
            const page = i + 1;
            return (
              <button
                key={page}
                type="button"
                onClick={() => dispatch({ type: "SET_PAGE", payload: page })}
                aria-current={criteria.page === page ? "page" : undefined}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  criteria.page === page
                    ? "border-blue-600 bg-blue-600 text-white"
                    : "border-neutral-300 hover:bg-neutral-50"
                }`}
              >
                {page}
              </button>
            );
          })}

          {totalPages > 7 && <span className="text-neutral-400">…</span>}

          <button
            type="button"
            disabled={criteria.page >= totalPages}
            onClick={() => dispatch({ type: "SET_PAGE", payload: criteria.page + 1 })}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-40 hover:bg-neutral-50"
            aria-label="Next page"
          >
            Next →
          </button>
        </nav>
      )}
    </div>
  );
}

export function ResultListSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2" aria-label="Loading results">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border bg-white">
          <Skeleton variant="rectangular" className="h-48 w-full rounded-none" />
          <div className="p-4">
            <Skeleton variant="text" className="mb-2 h-5 w-3/4" />
            <Skeleton variant="text" className="mb-3 h-4 w-1/2" />
            <div className="mb-3 flex gap-2">
              <Skeleton variant="rectangular" className="h-6 w-16 rounded-full" />
              <Skeleton variant="rectangular" className="h-6 w-16 rounded-full" />
            </div>
            <Skeleton variant="text" className="h-6 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
