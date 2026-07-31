import type { MetadataRoute } from "next";
import { SUPPORTED_LOCALES } from "@/lib/seo/metadata";

const BASE_URL = process.env["NEXT_PUBLIC_BASE_URL"] ?? "https://travelplatform.example.com";

/**
 * Dynamic sitemap with locale alternates.
 *
 * - Marketing and search pages: included with locale alternates
 * - Checkout, account, auth routes: EXCLUDED (noindex per AC9)
 * - Large listing catalogues should be paginated via a sitemap index;
 *   this returns up to 50,000 entries per Next.js limit.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  // ---------------------------------------------------------------------------
  // Static routes
  // ---------------------------------------------------------------------------
  const staticRoutes: Array<{ path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }> = [
    { path: "/", priority: 1.0, changeFrequency: "weekly" },
    { path: "/search", priority: 0.9, changeFrequency: "always" },
  ];

  const staticEntries: MetadataRoute.Sitemap = staticRoutes.flatMap(({ path, priority, changeFrequency }) =>
    SUPPORTED_LOCALES.map((locale) => {
      const localePrefix = locale === "en" ? "" : `/${locale}`;
      return {
        url: `${BASE_URL}${localePrefix}${path}`,
        lastModified: now,
        changeFrequency,
        priority,
        alternates: {
          languages: Object.fromEntries(
            SUPPORTED_LOCALES.map((loc) => [
              loc,
              `${BASE_URL}${loc === "en" ? "" : `/${loc}`}${path}`,
            ]),
          ),
        },
      };
    }),
  );

  // ---------------------------------------------------------------------------
  // Dynamic listing routes
  // In production this would fetch from the backend catalogue API.
  // When the API is unavailable, the sitemap gracefully omits dynamic entries.
  // ---------------------------------------------------------------------------
  let listingEntries: MetadataRoute.Sitemap = [];

  try {
    const apiBase = process.env["NEXT_PUBLIC_API_BASE_URL"];
    if (apiBase !== undefined) {
      const res = await fetch(`${apiBase}/listings/sitemap`, {
        next: { revalidate: 3600 },
      });
      if (res.ok) {
        interface ListingSlug {
          slug: string;
          updatedAt: string;
        }
        const slugs = (await res.json()) as ListingSlug[];
        listingEntries = slugs.flatMap(({ slug, updatedAt }) =>
          SUPPORTED_LOCALES.map((locale) => {
            const localePrefix = locale === "en" ? "" : `/${locale}`;
            return {
              url: `${BASE_URL}${localePrefix}/hotels/${slug}`,
              lastModified: new Date(updatedAt),
              changeFrequency: "daily" as const,
              priority: 0.7,
            };
          }),
        );
      }
    }
  } catch {
    // Gracefully omit dynamic entries on failure — static routes still served
  }

  return [...staticEntries, ...listingEntries];
}
