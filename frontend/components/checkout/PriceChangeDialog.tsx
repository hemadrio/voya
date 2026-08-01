"use client";

/**
 * PriceChangeDialog — discloses price changes discovered during re-validation
 * and requires explicit traveler acknowledgement before continuing (WO-068, AC5).
 */

import { Button } from "@/components/ui/Button.js";

interface PriceChangeDialogProps {
  isOpen: boolean;
  currency: string;
  previousTotal: number;
  newTotal: number;
  onAcknowledge: () => void;
  onDecline: () => void;
}

function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

export function PriceChangeDialog({
  isOpen,
  currency,
  previousTotal,
  newTotal,
  onAcknowledge,
  onDecline,
}: PriceChangeDialogProps) {
  if (!isOpen) return null;

  const diff = newTotal - previousTotal;
  const increased = diff > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="price-change-title"
      aria-describedby="price-change-desc"
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onDecline} aria-hidden="true" />

      <div className="relative z-10 w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2
          id="price-change-title"
          className="text-lg font-semibold text-neutral-900"
        >
          Price has changed
        </h2>

        <p id="price-change-desc" className="mt-2 text-sm text-neutral-600">
          The price of your booking has{" "}
          {increased ? "increased" : "decreased"} since you started checkout.
          Please review the updated total before continuing.
        </p>

        <div className="mt-4 rounded-lg border border-neutral-200 p-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-neutral-500">Previous total</span>
            <span className="text-neutral-500 line-through">
              {formatAmount(previousTotal, currency)}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span className="font-semibold text-neutral-900">New total</span>
            <span
              className={`font-bold ${increased ? "text-error-600" : "text-success-700"}`}
            >
              {formatAmount(newTotal, currency)}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="text-neutral-400">Difference</span>
            <span className={increased ? "text-error-600" : "text-success-700"}>
              {increased ? "+" : ""}
              {formatAmount(diff, currency)}
            </span>
          </div>
        </div>

        <p className="mt-3 text-xs text-neutral-500">
          By clicking "Accept and continue" you acknowledge the updated price.
        </p>

        <div className="mt-5 flex gap-3">
          <Button
            variant="outline"
            className="flex-1"
            onClick={onDecline}
          >
            Go back
          </Button>
          <Button
            className="flex-1"
            onClick={onAcknowledge}
          >
            Accept and continue
          </Button>
        </div>
      </div>
    </div>
  );
}
