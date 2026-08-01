"use client";

/**
 * RefundPreview — displays backend-sourced refund breakdown (WO-069, AC4).
 *
 * Constraint: all financial figures come from the backend preview response.
 * This component ONLY formats and displays — it never computes amounts.
 */

import type { CancellationPreview } from "@/lib/api/account.js";

function fmt(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

interface RefundPreviewProps {
  preview: CancellationPreview;
}

export function RefundPreview({ preview }: RefundPreviewProps) {
  const { refundableAmount, nonRefundableAmount, penalties, currency, settlementEtaDays } = preview;

  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm">
      <h3 className="mb-3 font-semibold text-neutral-900">Refund breakdown</h3>
      <dl className="space-y-2">
        <div className="flex justify-between">
          <dt className="text-neutral-600">Refundable amount</dt>
          <dd className="font-semibold text-success-700">{fmt(refundableAmount, currency)}</dd>
        </div>

        {penalties.map((p, i) => (
          <div key={i} className="flex justify-between">
            <dt className="text-neutral-500">{p.label}</dt>
            <dd className="text-error-600">−{fmt(p.amount, currency)}</dd>
          </div>
        ))}

        {nonRefundableAmount > 0 && (
          <div className="flex justify-between border-t border-neutral-200 pt-2">
            <dt className="text-neutral-500">Non-refundable fees</dt>
            <dd className="text-neutral-600">{fmt(nonRefundableAmount, currency)}</dd>
          </div>
        )}
      </dl>

      <p className="mt-3 text-xs text-neutral-500">
        Refunds are typically processed within{" "}
        <strong>{settlementEtaDays} business day{settlementEtaDays !== 1 ? "s" : ""}</strong>.
        Actual timeline depends on your payment provider.
      </p>
    </div>
  );
}
