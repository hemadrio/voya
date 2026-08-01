"use client";

/**
 * WishlistGrid — saved listings with optimistic removal + rollback on failure (WO-069, AC8).
 */

import { useState } from "react";
import { removeWishlistItem } from "@/lib/api/account.js";
import type { WishlistItem } from "@/lib/api/account.js";
import { useToast } from "@/components/ui/Toast.js";

interface WishlistGridProps {
  initialItems: WishlistItem[];
}

function fmt(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency", currency, minimumFractionDigits: 0,
  }).format(amount);
}

export function WishlistGrid({ initialItems }: WishlistGridProps) {
  const [items, setItems] = useState<WishlistItem[]>(initialItems);
  const { addToast } = useToast();

  async function handleRemove(listingId: string) {
    // Optimistic removal
    const previous = items;
    setItems((prev) => prev.filter((i) => i.listingId !== listingId));

    try {
      await removeWishlistItem(listingId);
    } catch {
      // Rollback
      setItems(previous);
      addToast({ message: "Unable to remove listing. Please try again.", variant: "error" });
    }
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-base font-medium text-neutral-700">Your wishlist is empty</p>
        <p className="max-w-xs text-sm text-neutral-500">
          Save listings you like while browsing and they'll appear here.
        </p>
        <a
          href="/search"
          className="mt-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Explore listings
        </a>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <div
          key={item.listingId}
          className="group relative rounded-xl border border-neutral-200 bg-white overflow-hidden shadow-sm"
        >
          {/* Hero image */}
          <div className="aspect-[16/10] bg-neutral-100 overflow-hidden">
            {item.heroImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.heroImage}
                alt=""
                className="h-full w-full object-cover transition-transform group-hover:scale-105"
              />
            )}
          </div>

          {/* Unavailable overlay */}
          {!item.available && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <span className="rounded-full bg-white/90 px-3 py-1 text-xs font-medium text-neutral-700">
                No longer available
              </span>
            </div>
          )}

          {/* Remove button */}
          <button
            type="button"
            onClick={() => handleRemove(item.listingId)}
            aria-label={`Remove ${item.title} from wishlist`}
            className="absolute right-2 top-2 rounded-full bg-white/80 p-1.5 text-neutral-600 shadow hover:bg-white hover:text-error-600"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>

          {/* Content */}
          <div className="p-3">
            <a
              href={`/listings/${item.listingSlug}`}
              className="block text-sm font-semibold text-neutral-900 hover:text-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 rounded"
            >
              {item.title}
            </a>
            <p className="mt-0.5 text-xs text-neutral-500">{item.location}</p>
            {item.priceFrom !== undefined && item.currency && (
              <p className="mt-1 text-xs text-neutral-700">
                From <span className="font-medium">{fmt(item.priceFrom, item.currency)}</span> / night
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
