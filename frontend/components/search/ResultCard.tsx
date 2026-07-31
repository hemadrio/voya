"use client";

import * as React from "react";
import Image from "next/image";
import { cn } from "@/lib/utils.js";
import { formatPrice } from "@/lib/search/params.js";
import type { SearchResultItem } from "@/lib/api/search.js";
import { useSearchContext } from "./SearchContext.js";

interface ResultCardProps {
  item: SearchResultItem;
  priority?: boolean;
}

const PLACEHOLDER_IMG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect width='400' height='300' fill='%23e5e7eb'/%3E%3C/svg%3E";

export function ResultCard({ item, priority = false }: ResultCardProps) {
  const { hoveredItemId, setHoveredItemId, selectedItemId, setSelectedItemId, criteria } =
    useSearchContext();

  const isHovered = hoveredItemId === item.id;
  const isSelected = selectedItemId === item.id;

  return (
    <article
      id={`result-card-${item.id}`}
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border bg-white transition-shadow hover:shadow-md",
        isHovered && "ring-2 ring-blue-400",
        isSelected && "ring-2 ring-blue-600",
      )}
      onMouseEnter={() => setHoveredItemId(item.id)}
      onMouseLeave={() => setHoveredItemId(null)}
      onClick={() => setSelectedItemId(item.id === selectedItemId ? null : item.id)}
      aria-selected={isSelected}
    >
      {/* Hero image */}
      <div className="relative h-48 w-full overflow-hidden bg-neutral-100">
        <Image
          src={item.heroImage?.url || PLACEHOLDER_IMG}
          alt={item.title}
          fill
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          className="object-cover"
          priority={priority}
          placeholder={item.heroImage?.blurHash?.startsWith("data:") ? "blur" : "empty"}
          blurDataURL={item.heroImage?.blurHash?.startsWith("data:") ? item.heroImage.blurHash : undefined}
          onError={(e) => {
            (e.target as HTMLImageElement).src = PLACEHOLDER_IMG;
          }}
        />
        {item.freeCancellation && (
          <span className="absolute left-2 top-2 rounded bg-green-600 px-2 py-0.5 text-xs font-medium text-white">
            Free cancellation
          </span>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col p-4">
        <div className="mb-1 flex items-start justify-between gap-2">
          <h2 className="flex-1 text-base font-semibold text-neutral-900 leading-snug">
            {item.title}
          </h2>
          {/* Wishlist button */}
          <button
            type="button"
            aria-label={item.wishlisted ? "Remove from wishlist" : "Add to wishlist"}
            aria-pressed={item.wishlisted}
            className="shrink-0 rounded-full p-1 text-neutral-400 hover:text-red-500"
            onClick={(e) => {
              e.stopPropagation();
              // Wishlist toggle handled by parent / auth layer
            }}
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill={item.wishlisted ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 016.364 0L12 7.636l1.318-1.318a4.5 4.5 0 116.364 6.364L12 20.364l-7.682-7.682a4.5 4.5 0 010-6.364z" />
            </svg>
          </button>
        </div>

        {/* Location */}
        <p className="mb-2 text-sm text-neutral-500">
          {item.location.city}, {item.location.country}
        </p>

        {/* Rating */}
        <div className="mb-2 flex items-center gap-1">
          <span className="rounded bg-blue-600 px-1.5 py-0.5 text-xs font-bold text-white">
            {item.rating.average.toFixed(1)}
          </span>
          <span className="text-xs text-neutral-500">
            ({item.rating.count.toLocaleString()} reviews)
          </span>
        </div>

        {/* Amenities */}
        {item.amenities.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1">
            {item.amenities.slice(0, 4).map((a) => (
              <span
                key={a}
                className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-600"
              >
                {a}
              </span>
            ))}
            {item.amenities.length > 4 && (
              <span className="rounded-full border border-neutral-200 px-2 py-0.5 text-xs text-neutral-600">
                +{item.amenities.length - 4} more
              </span>
            )}
          </div>
        )}

        {/* Price */}
        <div className="mt-auto border-t border-neutral-100 pt-3">
          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-lg font-bold text-neutral-900">
                {formatPrice(item.price.nightly, item.price.currency, criteria.locale)}
              </span>
              <span className="text-xs text-neutral-500"> / night</span>
            </div>
            {item.price.nights > 0 && (
              <div className="text-right">
                <div className="text-sm font-semibold text-neutral-800">
                  {formatPrice(item.price.total, item.price.currency, criteria.locale)} total
                </div>
                {!item.price.taxesIncluded && (
                  <div className="text-xs text-neutral-400">+ taxes & fees</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
