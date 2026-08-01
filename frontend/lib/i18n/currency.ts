/**
 * Currency preference management.
 *
 * The selected currency is persisted in a cookie so the backend can return
 * amounts already denominated in the traveler's currency.
 * Monetary conversion NEVER happens in the client.
 */

export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AED", "SAR"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const DEFAULT_CURRENCY: SupportedCurrency = "USD";

export function isSupportedCurrency(currency: string): currency is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(currency);
}

/** Display labels for currency switcher. */
export const CURRENCY_LABELS: Record<SupportedCurrency, string> = {
  USD: "USD — US Dollar",
  EUR: "EUR — Euro",
  GBP: "GBP — British Pound",
  JPY: "JPY — Japanese Yen",
  AED: "AED — UAE Dirham",
  SAR: "SAR — Saudi Riyal",
};
