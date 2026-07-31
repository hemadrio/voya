/**
 * Metadata helpers for Next.js App Router generateMetadata() functions.
 *
 * Provides typed builders for per-route metadata including title, description,
 * Open Graph, Twitter cards, canonical URLs, locale alternates, and noindex
 * directives.
 */

import type { Metadata } from "next";

const SITE_NAME = "TravelPlatform";
const BASE_URL = process.env["NEXT_PUBLIC_BASE_URL"] ?? "https://travelplatform.example.com";

export const SUPPORTED_LOCALES = ["en", "fr", "de", "es", "ja"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

// ---------------------------------------------------------------------------
// Base metadata builder
// ---------------------------------------------------------------------------

export interface PageMetadataInput {
  title: string;
  description: string;
  path: string;
  locale?: SupportedLocale;
  image?: {
    url: string;
    width?: number;
    height?: number;
    alt?: string;
  };
  noIndex?: boolean;
}

export function buildPageMetadata(input: PageMetadataInput): Metadata {
  const canonicalUrl = `${BASE_URL}${input.path}`;
  const locale = input.locale ?? "en";

  const localeAlternates: Record<string, string> = {};
  for (const loc of SUPPORTED_LOCALES) {
    localeAlternates[loc] =
      loc === "en"
        ? `${BASE_URL}${input.path}`
        : `${BASE_URL}/${loc}${input.path}`;
  }

  const ogImage = input.image ?? {
    url: `${BASE_URL}/og-default.png`,
    width: 1200,
    height: 630,
    alt: `${input.title} | ${SITE_NAME}`,
  };

  return {
    title: input.title,
    description: input.description,
    ...(input.noIndex === true
      ? {
          robots: {
            index: false,
            follow: false,
            googleBot: { index: false, follow: false },
          },
        }
      : {
          robots: {
            index: true,
            follow: true,
            googleBot: {
              index: true,
              follow: true,
              "max-image-preview": "large",
              "max-snippet": -1,
            },
          },
        }),
    alternates: {
      canonical: canonicalUrl,
      languages: localeAlternates,
    },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      title: input.title,
      description: input.description,
      url: canonicalUrl,
      locale: locale,
      images: [
        {
          url: ogImage.url,
          width: ogImage.width ?? 1200,
          height: ogImage.height ?? 630,
          alt: ogImage.alt ?? input.title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: input.title,
      description: input.description,
      images: [ogImage.url],
    },
  };
}

// ---------------------------------------------------------------------------
// Noindex helper — use for checkout and account routes
// ---------------------------------------------------------------------------

export function noIndexMetadata(title: string): Metadata {
  return {
    title,
    robots: {
      index: false,
      follow: false,
      googleBot: { index: false, follow: false },
    },
  };
}

// ---------------------------------------------------------------------------
// Route-specific metadata presets
// ---------------------------------------------------------------------------

export const HOME_METADATA: Metadata = buildPageMetadata({
  title: `${SITE_NAME} — Book Flights, Hotels & Cars`,
  description:
    "AI-powered travel booking. Search and book flights, hotels, and car rentals from hundreds of suppliers in one place.",
  path: "/",
});

export const SEARCH_METADATA: Metadata = buildPageMetadata({
  title: `Search Travel Deals | ${SITE_NAME}`,
  description:
    "Search and compare flights, hotels, and car rentals. Find the best prices from top suppliers.",
  path: "/search",
});

// Checkout and account are excluded from search indexing (AC9 constraint)
export const CHECKOUT_METADATA: Metadata = noIndexMetadata("Checkout");
export const ACCOUNT_METADATA: Metadata = noIndexMetadata("My Account");
