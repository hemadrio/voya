"use client";

/**
 * CurrencySwitcher — persists the selected currency in a cookie and exposes
 * it through the CurrencyContext so every priced API call picks it up.
 *
 * Monetary conversion NEVER happens in the client; switching currency causes
 * TanStack Query (or plain refetches) to invalidate cached priced responses
 * and re-fetch from the backend with the new currency parameter.
 */

import * as React from "react";
import { SUPPORTED_CURRENCIES, CURRENCY_LABELS } from "@/lib/i18n/currency.js";
import { useCurrency } from "@/lib/i18n/context.js";
import { useI18n } from "@/lib/i18n/context.js";
import type { SupportedCurrency } from "@/lib/i18n/currency.js";

export function CurrencySwitcher() {
  const { currency, setCurrency } = useCurrency();
  const { t } = useI18n();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as SupportedCurrency;
    setCurrency(next);
  }

  return (
    <div className="relative">
      <label htmlFor="currency-select" className="sr-only">
        {t("common.currency")}
      </label>
      <select
        id="currency-select"
        value={currency}
        onChange={handleChange}
        className="appearance-none rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 cursor-pointer"
        aria-label={t("common.currency")}
      >
        {SUPPORTED_CURRENCIES.map((cur) => (
          <option key={cur} value={cur}>
            {CURRENCY_LABELS[cur]}
          </option>
        ))}
      </select>
    </div>
  );
}
