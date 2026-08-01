/**
 * Locale negotiation — pure function, no framework dependencies, fully testable.
 *
 * Priority order:
 *   1. Persisted NEXT_LOCALE cookie
 *   2. Accept-Language header (best-match against supported locales)
 *   3. Default locale (en)
 */

import { SUPPORTED_LOCALES, DEFAULT_LOCALE, isSupportedLocale } from "./routing.js";
import type { SupportedLocale } from "./routing.js";

/**
 * Parse an Accept-Language header value and return ordered language tags.
 * e.g. "en-US,en;q=0.9,es;q=0.8" → ["en-US", "en", "es"]
 */
export function parseAcceptLanguage(header: string): string[] {
  return header
    .split(",")
    .map((part) => {
      const [tag, qParam] = part.trim().split(";");
      const q = qParam ? parseFloat(qParam.replace("q=", "").trim()) : 1.0;
      return { tag: (tag ?? "").trim(), q };
    })
    .filter((item) => item.tag.length > 0)
    .sort((a, b) => b.q - a.q)
    .map((item) => item.tag);
}

/**
 * Match a single language tag (e.g. "en-US", "es-419") to a supported locale.
 * Exact match first, then language-only prefix match.
 */
export function matchLocale(tag: string, supported: readonly string[]): SupportedLocale | null {
  const lower = tag.toLowerCase();

  // Exact match
  for (const locale of supported) {
    if (locale.toLowerCase() === lower) return locale as SupportedLocale;
  }

  // Language prefix match: "en-US" → "en"
  const lang = lower.split("-")[0];
  if (lang) {
    for (const locale of supported) {
      if (locale.toLowerCase() === lang) return locale as SupportedLocale;
    }
  }

  return null;
}

/**
 * Negotiate the active locale from cookie + Accept-Language header.
 *
 * @param cookieLocale  Value of the NEXT_LOCALE cookie (may be undefined/invalid)
 * @param acceptLanguage  Value of the Accept-Language header (may be undefined)
 * @returns  The negotiated SupportedLocale, always a valid value
 */
export function negotiateLocale(
  cookieLocale: string | undefined,
  acceptLanguage: string | undefined,
): SupportedLocale {
  // 1. Cookie preference
  if (cookieLocale && isSupportedLocale(cookieLocale)) {
    return cookieLocale;
  }

  // 2. Accept-Language header
  if (acceptLanguage) {
    for (const tag of parseAcceptLanguage(acceptLanguage)) {
      const match = matchLocale(tag, SUPPORTED_LOCALES);
      if (match) return match;
    }
  }

  // 3. Default
  return DEFAULT_LOCALE;
}
