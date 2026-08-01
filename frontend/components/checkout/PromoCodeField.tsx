"use client";

/**
 * PromoCodeField — inline promo code input with backend validation (WO-068, AC4).
 *
 * Shows recalculated total on success.
 * Specific error messages for PROMO_INVALID, PROMO_EXPIRED, PROMO_NOT_APPLICABLE.
 */

import { useState } from "react";
import { validatePromoCode } from "@/lib/api/bookings.js";
import type { PromoValidationResult } from "@/lib/api/bookings.js";
import { ApiError } from "@/lib/api/errors.js";
import { Button } from "@/components/ui/Button.js";
import { Input } from "@/components/ui/Input.js";

interface PromoCodeFieldProps {
  quoteId: string;
  currency: string;
  onApplied: (result: PromoValidationResult) => void;
  onRemoved: () => void;
  appliedCode?: string | null;
}

const PROMO_ERROR_MESSAGES: Record<string, string> = {
  PROMO_INVALID: "This promo code is not valid.",
  PROMO_EXPIRED: "This promo code has expired.",
  PROMO_NOT_APPLICABLE:
    "This promo code cannot be applied to your booking.",
};

export function PromoCodeField({
  quoteId,
  currency,
  onApplied,
  onRemoved,
  appliedCode,
}: PromoCodeFieldProps) {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApply() {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) {
      setError("Enter a promo code.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await validatePromoCode(trimmed, quoteId);
      onApplied(result);
      setCode("");
    } catch (err) {
      if (err instanceof ApiError) {
        const backendCode = (err as ApiError & { data?: { code?: string } }).data?.code;
        setError(
          backendCode
            ? (PROMO_ERROR_MESSAGES[backendCode] ?? err.message)
            : err.message,
        );
      } else {
        setError("Unable to apply promo code. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  if (appliedCode) {
    return (
      <div
        className="flex items-center justify-between rounded-md bg-success-50 border border-success-200 px-3 py-2 text-sm"
        role="status"
        aria-live="polite"
      >
        <span className="text-success-700">
          Promo code <strong>{appliedCode}</strong> applied
        </span>
        <button
          type="button"
          onClick={onRemoved}
          className="ml-3 text-neutral-500 hover:text-neutral-700 text-xs underline"
          aria-label={`Remove promo code ${appliedCode}`}
        >
          Remove
        </button>
      </div>
    );
  }

  return (
    <div>
      <label htmlFor="promo-code" className="mb-1 block text-sm font-medium text-neutral-700">
        Promo code
      </label>
      <div className="flex gap-2">
        <Input
          id="promo-code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setError(null);
          }}
          placeholder="Enter code"
          aria-invalid={!!error}
          aria-describedby={error ? "promo-error" : undefined}
          className="flex-1 uppercase"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleApply();
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          onClick={handleApply}
          loading={loading}
          disabled={!code.trim()}
        >
          Apply
        </Button>
      </div>
      {error && (
        <p id="promo-error" role="alert" className="mt-1 text-xs text-error-600">
          {error}
        </p>
      )}
    </div>
  );
}
