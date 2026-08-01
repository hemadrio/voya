"use client";

/**
 * PriceSummary — itemized total with optional promo discount display (WO-068, AC4).
 */

import { cn } from "@/lib/utils.js";

export interface LineItem {
  code: string;
  label: string;
  amount: number;
}

export interface PriceSummaryProps {
  currency: string;
  lineItems: LineItem[];
  discounts?: Array<{ code: string; label: string; amount: number }>;
  taxes?: Array<{ label: string; amount: number }>;
  total: number;
  promoDiscount?: { label: string; amount: number } | null;
  className?: string;
}

function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

export function PriceSummary({
  currency,
  lineItems,
  discounts,
  taxes,
  total,
  promoDiscount,
  className,
}: PriceSummaryProps) {
  return (
    <div className={cn("rounded-lg border border-neutral-200 p-4", className)}>
      <h3 className="mb-3 text-sm font-semibold text-neutral-700">Price breakdown</h3>
      <dl className="space-y-2">
        {lineItems.map((item) => (
          <div key={item.code} className="flex items-center justify-between text-sm">
            <dt className="text-neutral-600">{item.label}</dt>
            <dd className="font-medium text-neutral-900">{formatAmount(item.amount, currency)}</dd>
          </div>
        ))}

        {discounts?.map((discount) => (
          <div key={discount.code} className="flex items-center justify-between text-sm text-success-700">
            <dt>{discount.label}</dt>
            <dd className="font-medium">−{formatAmount(discount.amount, currency)}</dd>
          </div>
        ))}

        {promoDiscount && (
          <div className="flex items-center justify-between text-sm text-success-700">
            <dt>{promoDiscount.label}</dt>
            <dd className="font-medium">−{formatAmount(promoDiscount.amount, currency)}</dd>
          </div>
        )}

        {taxes?.map((tax, i) => (
          <div key={i} className="flex items-center justify-between text-sm">
            <dt className="text-neutral-500">{tax.label}</dt>
            <dd className="text-neutral-600">{formatAmount(tax.amount, currency)}</dd>
          </div>
        ))}

        <div className="border-t border-neutral-200 pt-2">
          <div className="flex items-center justify-between">
            <dt className="text-base font-semibold text-neutral-900">Total</dt>
            <dd className="text-base font-bold text-neutral-900">{formatAmount(total, currency)}</dd>
          </div>
        </div>
      </dl>
    </div>
  );
}
