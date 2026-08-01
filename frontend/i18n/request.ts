/**
 * Server-side catalogue loader.
 *
 * Loads the JSON message catalogue for the given locale,
 * falling back to the default locale if the catalogue is missing or malformed.
 * Reports catalogue load failures to console in development.
 */

import { DEFAULT_LOCALE } from "./routing.js";
import type { Messages } from "../lib/i18n/types.js";

/** Dynamically import a locale catalogue. */
async function importCatalogue(locale: string): Promise<Messages | null> {
  try {
    const mod = await import(`../messages/${locale}.json`, { assert: { type: "json" } });
    return mod.default as Messages;
  } catch {
    return null;
  }
}

/**
 * Load the message catalogue for the given locale.
 * Falls back to the default locale if unavailable.
 */
export async function loadMessages(locale: string): Promise<Messages> {
  const catalogue = await importCatalogue(locale);
  if (catalogue !== null) return catalogue;

  if (process.env["NODE_ENV"] === "development") {
    // eslint-disable-next-line no-console
    console.warn(`[i18n] Failed to load catalogue for locale "${locale}", falling back to "${DEFAULT_LOCALE}".`);
  }

  const fallback = await importCatalogue(DEFAULT_LOCALE);
  if (fallback !== null) return fallback;

  return {};
}
