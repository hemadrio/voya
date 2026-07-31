import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { SiteHeader } from "@/components/layout/SiteHeader.js";
import { SiteFooter } from "@/components/layout/SiteFooter.js";
import { Providers } from "@/components/layout/Providers.js";
import { RootErrorBoundary } from "@/components/layout/RootErrorBoundary.js";
import { SkipToContent } from "@/components/layout/SkipToContent.js";
import { getClientSession } from "@/lib/auth/session";

const BASE_URL = process.env["NEXT_PUBLIC_BASE_URL"] ?? "https://travelplatform.example.com";

export const metadata: Metadata = {
  title: {
    default: "TravelPlatform — Book Flights, Hotels & Cars",
    template: "%s | TravelPlatform",
  },
  description:
    "AI-powered travel booking. Search and book flights, hotels, and car rentals in one place.",
  metadataBase: new URL(BASE_URL),
  openGraph: {
    type: "website",
    siteName: "TravelPlatform",
    locale: "en",
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

export default async function RootLayout({ children }: { children: ReactNode }) {
  const initialSession = await getClientSession();

  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col bg-neutral-50">
        <SkipToContent />
        <Providers initialSession={initialSession}>
          <SiteHeader />
          <RootErrorBoundary>
            <main id="main-content" className="flex-1" tabIndex={-1}>
              {children}
            </main>
          </RootErrorBoundary>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
