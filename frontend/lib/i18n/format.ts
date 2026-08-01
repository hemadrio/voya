/**
 * Locale-aware formatting utilities.
 *
 * All instances are memoized per locale+options combination so the same
 * Intl object is reused across calls rather than reconstructed on every render.
 */

// ---------------------------------------------------------------------------
// Instance caches
// ---------------------------------------------------------------------------

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();
const pluralRules = new Map<string, Intl.PluralRules>();

function dateFormatterKey(locale: string, opts: Intl.DateTimeFormatOptions | undefined): string {
  return `${locale}::${JSON.stringify(opts ?? {})}`;
}

function numberFormatterKey(locale: string, opts: Intl.NumberFormatOptions | undefined): string {
  return `${locale}::${JSON.stringify(opts ?? {})}`;
}

function getDateFormatter(locale: string, opts?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = dateFormatterKey(locale, opts);
  let fmt = dateFormatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, opts);
    dateFormatters.set(key, fmt);
  }
  return fmt;
}

function getNumberFormatter(locale: string, opts?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = numberFormatterKey(locale, opts);
  let fmt = numberFormatters.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, opts);
    numberFormatters.set(key, fmt);
  }
  return fmt;
}

function getRelativeFormatter(locale: string): Intl.RelativeTimeFormat {
  let fmt = relativeFormatters.get(locale);
  if (!fmt) {
    fmt = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "long" });
    relativeFormatters.set(locale, fmt);
  }
  return fmt;
}

function getPluralRules(locale: string): Intl.PluralRules {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale, { type: "cardinal" });
    pluralRules.set(locale, rules);
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Public formatters
// ---------------------------------------------------------------------------

/**
 * Format a date for display. Uses a listing timezone when provided.
 */
export function formatDate(
  date: Date | string | number,
  locale: string,
  options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" },
): string {
  return getDateFormatter(locale, options).format(new Date(date));
}

/**
 * Format a date range as a single string, e.g. "Jan 5 – Jan 12, 2025".
 */
export function formatDateRange(
  start: Date | string | number,
  end: Date | string | number,
  locale: string,
  options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" },
): string {
  const fmt = getDateFormatter(locale, options);
  return fmt.formatRange(new Date(start), new Date(end));
}

/**
 * Format a monetary amount with currency symbol and correct decimal places.
 * Zero-decimal currencies (JPY) and three-decimal currencies (KWD) are handled
 * by Intl.NumberFormat automatically.
 */
export function formatMoney(
  amount: number,
  currency: string,
  locale: string,
): string {
  return getNumberFormatter(locale, {
    style: "currency",
    currency,
    currencyDisplay: "symbol",
  }).format(amount);
}

/**
 * Format a plain number with locale-appropriate separators.
 */
export function formatNumber(
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions,
): string {
  return getNumberFormatter(locale, options).format(value);
}

/**
 * Format a night count with correct plural form for the locale.
 *
 * Examples:
 *   en: "1 night", "2 nights"
 *   ar: follows Arabic plural rules (0/1/2/3-10/11+)
 */
export function formatNights(count: number, locale: string): string {
  const rules = getPluralRules(locale);
  const form = rules.select(count);

  const pluralForms: Record<string, Record<string, string>> = {
    en: { one: "night", other: "nights" },
    es: { one: "noche", other: "noches" },
    ar: { zero: "ليلة", one: "ليلة", two: "ليلتان", few: "ليالٍ", many: "ليلة", other: "ليالٍ" },
  };

  const forms = pluralForms[locale] ?? pluralForms["en"] ?? {};
  const noun = forms[form] ?? forms["other"] ?? "nights";

  return `${formatNumber(count, locale)} ${noun}`;
}

/**
 * Format a guest count with correct plural form for the locale.
 */
export function formatGuests(count: number, locale: string): string {
  const rules = getPluralRules(locale);
  const form = rules.select(count);

  const pluralForms: Record<string, Record<string, string>> = {
    en: { one: "guest", other: "guests" },
    es: { one: "huésped", other: "huéspedes" },
    ar: { zero: "ضيف", one: "ضيف", two: "ضيفان", few: "ضيوف", many: "ضيفاً", other: "ضيوف" },
  };

  const forms = pluralForms[locale] ?? pluralForms["en"] ?? {};
  const noun = forms[form] ?? forms["other"] ?? "guests";

  return `${formatNumber(count, locale)} ${noun}`;
}

/**
 * Format a relative time expression, e.g. "3 days ago", "in 2 hours".
 */
export function formatRelative(
  date: Date | string | number,
  now: Date | string | number,
  locale: string,
): string {
  const diffMs = new Date(date).getTime() - new Date(now).getTime();
  const diffSeconds = Math.round(diffMs / 1000);

  const thresholds: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "second"],
    [3600, "minute"],
    [86400, "hour"],
    [604800, "day"],
    [2592000, "week"],
    [31536000, "month"],
    [Infinity, "year"],
  ];

  const absDiff = Math.abs(diffSeconds);
  for (const [threshold, unit] of thresholds) {
    if (absDiff < threshold) {
      const divisors: Record<string, number> = {
        second: 1, minute: 60, hour: 3600, day: 86400,
        week: 604800, month: 2592000, year: 31536000,
      };
      const divisor = divisors[unit] ?? 1;
      return getRelativeFormatter(locale).format(Math.round(diffSeconds / divisor), unit);
    }
  }

  return getRelativeFormatter(locale).format(Math.round(diffSeconds / 31536000), "year");
}
