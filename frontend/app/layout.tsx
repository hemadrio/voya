import type { Metadata } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import "./globals.css";

const BASE_URL = process.env["NEXT_PUBLIC_BASE_URL"] ?? "https://travelplatform.example.com";

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: "TravelPlatform — Book Flights, Hotels & Cars",
    template: "%s | TravelPlatform",
  },
  description:
    "AI-powered travel booking. Search and book flights, hotels, and car rentals in one place.",
  openGraph: {
    type: "website",
    siteName: "TravelPlatform",
  },
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
};

const RTL_LOCALES = new Set(["ar"]);

/**
 * Root layout.
 *
 * Sets html[lang] and html[dir] from the x-locale header injected by middleware.
 * All providers, header, and footer are now in app/[locale]/layout.tsx so that
 * locale context is available to every nested component.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  const locale = headers().get("x-locale") ?? "en";
  const dir = RTL_LOCALES.has(locale) ? "rtl" : "ltr";

  return (
    <html lang={locale} dir={dir}>
      <body className="min-h-screen flex flex-col bg-neutral-50">{children}</body>
    </html>
  );
}
