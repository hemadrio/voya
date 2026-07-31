import type { MetadataRoute } from "next";

const BASE_URL = process.env["NEXT_PUBLIC_BASE_URL"] ?? "https://travelplatform.example.com";

/**
 * Dynamic robots.txt.
 *
 * Disallowed paths (AC9):
 * - /checkout* — payment flows must not be indexed
 * - /account*  — personal account data must not be indexed
 * - /api/*     — API routes
 * - /sign-in, /sign-up, /forgot-password, /reset-password, /verify-email
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/search"],
        disallow: [
          "/checkout",
          "/checkout/",
          "/account",
          "/account/",
          "/api/",
          "/sign-in",
          "/sign-up",
          "/forgot-password",
          "/reset-password",
          "/verify-email",
        ],
      },
      // Prevent crawlers from following search result pages with many params
      {
        userAgent: "Googlebot",
        allow: ["/", "/search"],
        disallow: ["/checkout/", "/account/", "/api/"],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  };
}
