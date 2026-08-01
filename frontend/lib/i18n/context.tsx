"use client";

/**
 * React context for locale and currency preferences.
 *
 * Provided by the [locale] layout and consumed by any client component that
 * needs the current locale, the t() translation function, or the active currency.
 */

import * as React from "react";
import type { MessageKey } from "./types.js";
import { CURRENCY_COOKIE_NAME, LOCALE_COOKIE_NAME } from "../../i18n/routing.js";
import { DEFAULT_CURRENCY, isSupportedCurrency } from "./currency.js";
import type { SupportedCurrency } from "./currency.js";

// ---------------------------------------------------------------------------
// i18n context
// ---------------------------------------------------------------------------

interface I18nContextValue {
  locale: string;
  /** Translate a message key, with optional {param} interpolation. */
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

const I18nContext = React.createContext<I18nContextValue>({
  locale: "en",
  t: (key) => key,
});

/** Resolve a dot-notation key from a nested messages object. */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Interpolate {param} placeholders in a message string. */
function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const val = params[key];
    return val !== undefined ? String(val) : `{${key}}`;
  });
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface I18nProviderProps {
  locale: string;
  messages: Record<string, unknown>;
  children: React.ReactNode;
}

export function I18nProvider({ locale, messages, children }: I18nProviderProps) {
  const t = React.useCallback(
    (key: MessageKey, params?: Record<string, string | number>): string => {
      const raw = resolvePath(messages, key);
      if (typeof raw !== "string") {
        if (process.env["NODE_ENV"] === "development") {
          // eslint-disable-next-line no-console
          console.warn(`[i18n] Missing translation key: "${key}" for locale "${locale}"`);
        }
        return key;
      }
      return params ? interpolate(raw, params) : raw;
    },
    [locale, messages],
  );

  const value = React.useMemo(() => ({ locale, t }), [locale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useI18n(): I18nContextValue {
  return React.useContext(I18nContext);
}

// ---------------------------------------------------------------------------
// Currency context
// ---------------------------------------------------------------------------

interface CurrencyContextValue {
  currency: SupportedCurrency;
  setCurrency: (currency: SupportedCurrency) => void;
}

const CurrencyContext = React.createContext<CurrencyContextValue>({
  currency: DEFAULT_CURRENCY,
  setCurrency: () => {},
});

interface CurrencyProviderProps {
  initialCurrency: SupportedCurrency;
  children: React.ReactNode;
}

export function CurrencyProvider({ initialCurrency, children }: CurrencyProviderProps) {
  const [currency, setCurrencyState] = React.useState<SupportedCurrency>(initialCurrency);

  const setCurrency = React.useCallback((next: SupportedCurrency) => {
    if (!isSupportedCurrency(next)) return;
    setCurrencyState(next);
    // Persist to cookie so subsequent requests carry the preference
    document.cookie = `${CURRENCY_COOKIE_NAME}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
  }, []);

  const value = React.useMemo(() => ({ currency, setCurrency }), [currency, setCurrency]);

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency(): CurrencyContextValue {
  return React.useContext(CurrencyContext);
}

/**
 * Read the locale cookie value (client-side only).
 */
export function getLocaleCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE_NAME}=([^;]+)`));
  return match?.[1] ?? null;
}
