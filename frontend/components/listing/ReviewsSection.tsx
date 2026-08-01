"use client";

import * as React from "react";
import Image from "next/image";
import type { Review, ReviewSort, ListingRating } from "@/lib/api/listings.js";
import { getReviews } from "@/lib/api/listings.js";

interface ReviewsSectionProps {
  listingId: string;
  rating: ListingRating;
  initialReviews: Review[];
  initialCursor: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  cleanliness: "Cleanliness",
  accuracy: "Accuracy",
  communication: "Communication",
  location: "Location",
  check_in: "Check-in",
  value: "Value",
};

const SORT_OPTIONS: { value: ReviewSort; label: string }[] = [
  { value: "relevance", label: "Most relevant" },
  { value: "newest", label: "Newest first" },
  { value: "highest", label: "Highest rated" },
  { value: "lowest", label: "Lowest rated" },
];

function StarBar({ value }: { value: number }) {
  const pct = Math.round((value / 5) * 100);
  return (
    <div className="flex items-center gap-2">
      <div
        className="relative h-2 flex-1 overflow-hidden rounded-full bg-neutral-200"
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={5}
        aria-label={`${value} out of 5`}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-neutral-900"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-8 text-right text-xs tabular-nums text-neutral-600">
        {value.toFixed(1)}
      </span>
    </div>
  );
}

function ReviewCard({ review }: { review: Review }) {
  const date = new Date(review.createdAt).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  return (
    <article className="border-t border-neutral-200 py-6">
      <div className="flex items-center gap-3">
        <div className="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded-full">
          <Image
            src={review.author.avatarUrl}
            alt={review.author.name}
            fill
            sizes="40px"
            className="object-cover"
          />
        </div>
        <div>
          <p className="font-semibold text-neutral-900">{review.author.name}</p>
          <p className="text-xs text-neutral-500">{date}</p>
        </div>
        <div className="ml-auto flex items-center gap-1 text-sm">
          <span aria-hidden="true" className="text-yellow-500">★</span>
          <span>{review.rating}</span>
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-neutral-700">{review.body}</p>
      {review.hostReply && (
        <div className="mt-3 rounded-lg bg-neutral-50 p-3 text-sm">
          <p className="mb-1 font-semibold text-neutral-800">Host reply</p>
          <p className="text-neutral-600">{review.hostReply}</p>
        </div>
      )}
    </article>
  );
}

export function ReviewsSection({
  listingId,
  rating,
  initialReviews,
  initialCursor,
}: ReviewsSectionProps) {
  const [reviews, setReviews] = React.useState<Review[]>(initialReviews);
  const [cursor, setCursor] = React.useState<string | null>(initialCursor);
  const [sort, setSort] = React.useState<ReviewSort>("relevance");
  const [minRating, setMinRating] = React.useState<number | undefined>();
  const [loading, setLoading] = React.useState(false);

  const loadMore = React.useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const res = await getReviews(listingId, { cursor, sort, minRating });
      setReviews((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [cursor, listingId, loading, sort, minRating]);

  // Reset and reload when filters change
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReviews([]);
    setCursor(null);
    getReviews(listingId, { sort, minRating }).then((res) => {
      if (!cancelled) {
        setReviews(res.items);
        setCursor(res.nextCursor);
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [listingId, sort, minRating]);

  return (
    <section aria-labelledby="reviews-heading">
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <h2 id="reviews-heading" className="text-xl font-semibold text-neutral-900">
          <span aria-hidden="true">★</span>{" "}
          {rating.average.toFixed(2)} · {rating.count} reviews
        </h2>
      </div>

      {/* Category breakdown */}
      {rating.categories.length > 0 && (
        <div className="mb-6 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
          {rating.categories.map((cat) => (
            <div key={cat.code}>
              <p className="mb-1 text-xs text-neutral-600">
                {CATEGORY_LABELS[cat.code] ?? cat.code}
              </p>
              <StarBar value={cat.average} />
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-3">
        <label className="flex items-center gap-1 text-sm">
          <span className="text-neutral-600">Sort:</span>
          <select
            className="rounded border border-neutral-300 bg-white py-1 pl-2 pr-6 text-sm"
            value={sort}
            onChange={(e) => setSort(e.target.value as ReviewSort)}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-sm">
          <span className="text-neutral-600">Min rating:</span>
          <select
            className="rounded border border-neutral-300 bg-white py-1 pl-2 pr-6 text-sm"
            value={minRating ?? ""}
            onChange={(e) => setMinRating(e.target.value ? Number(e.target.value) : undefined)}
          >
            <option value="">All</option>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>{n}+ stars</option>
            ))}
          </select>
        </label>
      </div>

      {/* Review list */}
      {reviews.length === 0 && !loading && (
        <p className="py-4 text-sm text-neutral-500">No reviews match your filters.</p>
      )}

      <div role="list" aria-label="Guest reviews">
        {reviews.map((r) => (
          <ReviewCard key={r.id} review={r} />
        ))}
      </div>

      {cursor && (
        <div className="mt-4">
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="rounded-lg border border-neutral-900 px-5 py-2.5 text-sm font-semibold disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load more reviews"}
          </button>
        </div>
      )}
    </section>
  );
}
