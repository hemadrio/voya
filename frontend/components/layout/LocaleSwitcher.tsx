"use client";

/**
 * LocaleSwitcher — changes the URL locale prefix while preserving the
 * current path and all search params. Persists the selection in a cookie
 * so the preference survives reloads and sign-in/sign-out cycles.
 */

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { SUPPORTED_LOCALES, LOCALE_COOKIE_NAME } from "../../i18n/routing.js";
import { useI18n } from "@/lib/i18n/context.js";

const LOCALE_LABELS: Record<string, string> = {
  en: "English",
  es: "Español",
  ar: "العربية",
};

/** Strip the locale prefix from a pathname (e.g. "/en/search" → "/search"). */
function stripLocale(pathname: string): string {
  for (const locale of SUPPORTED_LOCALES) {
    if (pathname === `/${locale}`) return "/";
    if (pathname.startsWith(`/${locale}/`)) return pathname.slice(locale.length + 1);
  }
  return pathname;
}

export function LocaleSwitcher() {
  const { locale, t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function switchLocale(nextLocale: string) {
    if (nextLocale === locale) return;

    // Persist preference in cookie (1 year, SameSite=Lax)
    document.cookie = `${LOCALE_COOKIE_NAME}=${nextLocale}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;

    // Build the new URL: /{nextLocale}{bare-path}?{search}
    const bare = stripLocale(pathname);
    const search = searchParams.toString();
    const newPath = `/${nextLocale}${bare === "/" ? "" : bare}${search ? `?${search}` : ""}`;

    router.push(newPath);
  }

  return (
    <div className="relative">
      <label htmlFor="locale-select" className="sr-only">
        {t("common.language")}
      </label>
      <select
        id="locale-select"
        value={locale}
        onChange={(e) => switchLocale(e.target.value)}
        className="appearance-none rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-brand-500 cursor-pointer"
        aria-label={t("common.language")}
      >
        {SUPPORTED_LOCALES.map((loc) => (
          <option key={loc} value={loc}>
            {LOCALE_LABELS[loc] ?? loc}
          </option>
        ))}
      </select>
    </div>
  );
}
