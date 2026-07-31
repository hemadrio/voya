"use client";

/**
 * Next.js error boundary for the search route.
 * Renders a retry UI that re-invokes the server component fetch
 * while preserving all URL criteria.
 */

import * as React from "react";

interface SearchErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function SearchError({ error, reset }: SearchErrorProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-8 text-center shadow-sm">
        <div className="mb-4 text-4xl" aria-hidden>⚠️</div>
        <h1 className="mb-2 text-xl font-semibold text-neutral-900">Search unavailable</h1>
        <p className="mb-6 text-sm text-neutral-500">
          We couldn&apos;t load your search results. Your filters and criteria have been preserved.
        </p>
        {process.env.NODE_ENV !== "production" && error.message && (
          <pre className="mb-4 overflow-auto rounded bg-neutral-100 px-3 py-2 text-left text-xs text-neutral-700">
            {error.message}
          </pre>
        )}
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-blue-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
