/**
 * Shared generateMetadata helper for locale-aware pages.
 *
 * Returns localized title/description plus canonical URL and hreflang alternates
 * (one per supported locale + x-default pointing to the default locale).
 */

import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from "../../i18n/routing.js";

const BASE_URL =
  process.env["NEXT_PUBLIC_BASE_URL"] ?? "https://travelplatform.example.com";

export interface LocaleMetadataInput {
  locale: string;
  path: string; // e.g. "/search" or "/" (bare path, no locale prefix)
  title: string;
  description?: string;
}

/**
 * Build the `alternates` block for Next.js Metadata with:
 *   - canonical pointing to the current locale
 *   - hreflang for each supported locale
 *   - x-default pointing to the default locale
 */
export function buildAlternates(locale: string, path: string) {
  const normPath = path === "/" ? "" : path;
  const canonical = `${BASE_URL}/${locale}${normPath}`;

  const languages: Record<string, string> = {};
  for (const loc of SUPPORTED_LOCALES) {
    languages[loc] = `${BASE_URL}/${loc}${normPath}`;
  }
  // x-default points to the default locale
  languages["x-default"] = `${BASE_URL}/${DEFAULT_LOCALE}${normPath}`;

  return { canonical, languages };
}
