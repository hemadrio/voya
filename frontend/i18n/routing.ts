/**
 * i18n routing configuration.
 *
 * Defines the supported locales, default locale, and direction lookup.
 * Adding a new locale requires only: a new messages/{locale}.json file and
 * an entry in SUPPORTED_LOCALES — no per-route code changes.
 */

export const SUPPORTED_LOCALES = ["en", "es", "ar"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = "en";

/** Locales that require right-to-left layout. */
const RTL_LOCALES = new Set<string>(["ar"]);

export function isRTL(locale: string): boolean {
  return RTL_LOCALES.has(locale);
}

export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale);
}

export const LOCALE_COOKIE_NAME = "NEXT_LOCALE";
export const CURRENCY_COOKIE_NAME = "NEXT_CURRENCY";
export const LOCALE_HEADER = "x-locale";
