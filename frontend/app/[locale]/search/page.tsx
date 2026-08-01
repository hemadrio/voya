import type { Metadata } from "next";
import { Suspense } from "react";
import { SearchPageClient } from "@/components/search/SearchPageClient.js";
import { parseSearchParams } from "@/lib/search/params.js";
import { fetchSearch } from "@/lib/api/search.js";
import type { SearchResponse } from "@/lib/api/search.js";
import { ResultListSkeleton } from "@/components/search/ResultList.js";
import { loadMessages } from "../../../i18n/request.js";
import { isSupportedLocale } from "../../../i18n/routing.js";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../../../i18n/routing.js";

const BASE_URL = process.env["NEXT_PUBLIC_BASE_URL"] ?? "https://travelplatform.example.com";

interface SearchPageProps {
  searchParams: Record<string, string | string[] | undefined>;
  params: { locale: string };
}

export async function generateMetadata({ params }: { params: { locale: string } }): Promise<Metadata> {
  const locale = isSupportedLocale(params.locale) ? params.locale : DEFAULT_LOCALE;
  const messages = await loadMessages(locale);
  const msg = messages as Record<string, Record<string, string>>;
  const title = msg["search"]?.["title"] ?? "Search results";

  return {
    title,
    alternates: {
      canonical: `${BASE_URL}/${locale}/search`,
      languages: Object.fromEntries(
        SUPPORTED_LOCALES.map((l) => [l, `${BASE_URL}/${l}/search`])
      ) as Record<string, string>,
    },
  };
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const criteria = parseSearchParams(searchParams);

  let initialData: SearchResponse | null = null;
  try {
    initialData = await fetchSearch(criteria);
  } catch {
    // Client will retry
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
