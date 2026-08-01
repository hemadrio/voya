"use client";

/**
 * ExtrasStep — step 2: optional extras + promo code (WO-068, AC4).
 */

import { useState } from "react";
import type { PromoValidationResult } from "@/lib/api/bookings.js";
import { PromoCodeField } from "./PromoCodeField.js";
import { PriceSummary } from "./PriceSummary.js";
import type { PriceSummaryProps } from "./PriceSummary.js";
import { Button } from "@/components/ui/Button.js";

export interface Extra {
  code: string;
  label: string;
  description?: string;
  pricePerUnit: number;
  currency: string;
  maxQuantity: number;
}

interface ExtrasStepProps {
  quoteId: string;
  availableExtras: Extra[];
  priceSummary: Omit<PriceSummaryProps, "promoDiscount">;
  initialExtras?: Record<string, number>;
  initialPromoCode?: string;
  onSubmit: (extras: Record<string, number>, promoCode?: string, promoDiscount?: { label: string; amount: number }) => void | Promise<void>;
  onBack: () => void;
  loading?: boolean;
}

export function ExtrasStep({
  quoteId,
  availableExtras,
  priceSummary,
  initialExtras = {},
  initialPromoCode,
  onSubmit,
  onBack,
  loading = false,
}: ExtrasStepProps) {
  const [quantities, setQuantities] = useState<Record<string, number>>(initialExtras);
  const [promoResult, setPromoResult] = useState<PromoValidationResult | null>(null);
  const [appliedCode, setAppliedCode] = useState<string | null>(initialPromoCode ?? null);

  function handleQtyChange(code: string, delta: number) {
    setQuantities((prev) => {
      const extra = availableExtras.find((e) => e.code === code);
      if (!extra) return prev;
      const current = prev[code] ?? 0;
      const next = Math.max(0, Math.min(extra.maxQuantity, current + delta));
      return { ...prev, [code]: next };
    });
  }

  function handlePromoApplied(result: PromoValidationResult) {
    setPromoResult(result);
    setAppliedCode(result.code);
  }

  function handlePromoRemoved() {
    setPromoResult(null);
    setAppliedCode(null);
  }

  const displayTotal = promoResult?.newTotal ?? priceSummary.total;
  const promoDiscount = promoResult
    ? { label: `Promo: ${promoResult.code}`, amount: promoResult.discountAmount }
    : undefined;

  return (
    <div className="space-y-6">
      {availableExtras.length > 0 ? (
        <fieldset>
          <legend className="text-base font-semibold text-neutral-900">Add extras</legend>
          <div className="mt-3 space-y-3">
            {availableExtras.map((extra) => {
              const qty = quantities[extra.code] ?? 0;
              return (
                <div
                  key={extra.code}
                  className="flex items-center justify-between rounded-lg border border-neutral-200 p-4"
                >
                  <div>
                    <p className="text-sm font-medium text-neutral-900">{extra.label}</p>
                    {extra.description && (
                      <p className="text-xs text-neutral-500">{extra.description}</p>
                    )}
                    <p className="text-xs text-neutral-500">
                      +{new Intl.NumberFormat("en-GB", {
                        style: "currency",
                        currency: extra.currency,
                      }).format(extra.pricePerUnit)}{" "}
                      each
                    </p>
                  </div>
                  <div className="flex items-center gap-2" role="group" aria-label={`${extra.label} quantity`}>
                    <button
                      type="button"
                      onClick={() => handleQtyChange(extra.code, -1)}
                      disabled={qty === 0}
                      aria-label={`Decrease ${extra.label}`}
                      className="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-300 text-neutral-600 hover:bg-neutral-50 disabled:opacity-40"
                    >
                      −
                    </button>
                    <span
                      className="w-6 text-center text-sm font-medium tabular-nums"
                      aria-live="polite"
                    >
                      {qty}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleQtyChange(extra.code, 1)}
                      disabled={qty >= extra.maxQuantity}
                      aria-label={`Increase ${extra.label}`}
                      className="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-300 text-neutral-600 hover:bg-neutral-50 disabled:opacity-40"
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </fieldset>
      ) : (
        <p className="text-sm text-neutral-500">No extras available for this booking.</p>
      )}

      <PromoCodeField
        quoteId={quoteId}
        currency={priceSummary.currency}
        onApplied={handlePromoApplied}
        onRemoved={handlePromoRemoved}
        appliedCode={appliedCode}
      />

      <PriceSummary
        {...priceSummary}
        total={displayTotal}
        promoDiscount={promoDiscount}
      />

      <div className="flex gap-3">
        <Button variant="outline" className="flex-1" onClick={onBack} type="button">
          Back
        </Button>
        <Button
          className="flex-1"
          type="button"
          loading={loading}
          onClick={() =>
            onSubmit(
              quantities,
              appliedCode ?? undefined,
              promoDiscount,
            )
          }
        >
          Continue to review
        </Button>
      </div>
    </div>
  );
}
