/**
 * Search results page — async Server Component (Next.js 14 App Router).
 *
 * Reads all criteria from URL search params, fetches the first page server-side
 * for SEO and perceived performance, then hands off to SearchPageClient for
 * subsequent client interactions. URL is the single source of truth.
 */

import { Suspense } from "react";
import { SearchPageClient } from "@/components/search/SearchPageClient.js";
import { parseSearchParams } from "@/lib/search/params.js";
import { fetchSearch } from "@/lib/api/search.js";
import type { SearchResponse } from "@/lib/api/search.js";
import { ResultListSkeleton } from "@/components/search/ResultList.js";

interface SearchPageProps {
  searchParams: Record<string, string | string[] | undefined>;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const criteria = parseSearchParams(searchParams);

  // Attempt server-side fetch for the initial render.
  // Failures are silently swallowed — the client will retry.
  let initialData: SearchResponse | null = null;
  try {
    initialData = await fetchSearch(criteria);
  } catch {
    // Let SearchPageClient handle the error on the client side
  }

  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-neutral-50 px-4 py-6">
          <div className="mx-auto max-w-7xl">
            <ResultListSkeleton />
          </div>
        </div>
      }
    >
      <SearchPageClient initialCriteria={criteria} initialData={initialData} />
    </Suspense>
  );
}

export const dynamic = "force-dynamic";
