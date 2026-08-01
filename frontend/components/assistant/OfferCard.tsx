/**
 * OfferCard — renders a grounded offer strictly from structured payload (WO-062 AC3/AC4).
 *
 * Security invariants:
 *   - All displayed values come from the structured offer_card payload.
 *   - No field value is parsed from assistant prose.
 *   - dangerouslySetInnerHTML is absent.
 *   - Stale cards display a re-verify affordance and suppress availability wording.
 *
 * The offerRef (offerId) is passed directly into the checkout route query param
 * without modification.
 */

"use client";

import * as React from "react";
import { cn } from "@/lib/utils.js";
import { Button } from "@/components/ui/Button.js";
import type { OfferCardState } from "@/lib/assistant/chatReducer.js";

// ---------------------------------------------------------------------------
// Freshness threshold — mirrors the server-side value (WO-060)
// ---------------------------------------------------------------------------

const FRESH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function formatRelativeTime(retrievedAtMs: number): string {
  const diffMs = Date.now() - retrievedAtMs;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr} hr ago`;
}

function isStale(retrievedAtMs: number | undefined, staleFlag: boolean | undefined): boolean {
  if (staleFlag === true) return true;
  if (retrievedAtMs === undefined) return false;
  return Date.now() - retrievedAtMs > FRESH_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface OfferCardProps {
  card: OfferCardState;
  onSelect?: (offerId: string) => void;
}

export function OfferCard({ card, onSelect }: OfferCardProps): React.ReactElement {
  const stale = isStale(card.retrievedAt, card.stale);
  const retrievedLabel = card.retrievedAt ? formatRelativeTime(card.retrievedAt) : undefined;

  const handleSelect = (): void => {
    if (onSelect) {
      onSelect(card.offerId);
    } else {
      // Default: navigate to checkout with offerRef — matches the checkout page
      // SearchParams pattern (offerId query param, see app/checkout/page.tsx)
      window.location.assign(`/checkout?offerId=${encodeURIComponent(card.offerId)}`);
    }
  };

  const handleReVerify = (): void => {
    // Re-navigate to the same offer to get a fresh quote
    window.location.assign(`/checkout?offerId=${encodeURIComponent(card.offerId)}`);
  };

  return (
    <article
      className={cn(
        "rounded-xl border p-4 flex flex-col gap-3 bg-white",
        stale ? "border-amber-300 bg-amber-50/30" : "border-neutral-200",
      )}
      aria-label={
        card.displayTitle
          ? `Offer: ${card.displayTitle}`
          : `Offer from ${card.provenance}`
      }
    >
      {/* Stale banner — suppresses "available" wording (AC4) */}
      {stale && (
        <div
          className="flex items-center gap-2 text-xs text-amber-700 bg-amber-100 rounded-lg px-3 py-1.5"
          role="alert"
          aria-live="polite"
        >
          <span aria-hidden="true">⚠</span>
          <span>Price may have changed — re-verify before booking</span>
        </div>
      )}

      {/* Title */}
      {card.displayTitle && (
        <h3 className="text-sm font-semibold text-neutral-900 leading-snug">
          {/* Plain text — no HTML */}
          {card.displayTitle}
        </h3>
      )}

      {/* Summary */}
      {card.displaySummary && (
        <p className="text-xs text-neutral-600 leading-relaxed">
          {/* Plain text — no HTML */}
          {card.displaySummary}
        </p>
      )}

      {/* Structured facts row */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {card.price !== undefined && card.currency && (
          <>
            <dt className="text-neutral-500">Price</dt>
            <dd className="text-neutral-900 font-medium" aria-label={`${card.price} ${card.currency}`}>
              {/* Price is from structured payload — never parsed from text */}
              {card.currency} {card.price.toLocaleString()}
            </dd>
          </>
        )}
        <dt className="text-neutral-500">Provider</dt>
        <dd className="text-neutral-700">{card.provenance}</dd>
        {retrievedLabel && (
          <>
            <dt className="text-neutral-500">Retrieved</dt>
            <dd
              className={cn(
                "text-neutral-700",
                stale && "text-amber-700 font-medium",
              )}
            >
              {retrievedLabel}
            </dd>
          </>
        )}
      </dl>

      {/* Actions */}
      <div className="flex gap-2 mt-1">
        {stale ? (
          // Stale: show re-verify affordance; suppress "book now" wording (AC4)
          <Button
            size="sm"
            variant="outline"
            onClick={handleReVerify}
            aria-label={`Re-verify price for ${card.displayTitle ?? "this offer"}`}
          >
            Re-verify price
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={handleSelect}
            aria-label={`Select offer${card.displayTitle ? `: ${card.displayTitle}` : ""}`}
          >
            Select offer
          </Button>
        )}
      </div>
    </article>
  );
}
