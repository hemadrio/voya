import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { SiteHeader } from "@/components/layout/SiteHeader.js";
import { SiteFooter } from "@/components/layout/SiteFooter.js";
import { Providers } from "@/components/layout/Providers.js";
import { RootErrorBoundary } from "@/components/layout/RootErrorBoundary.js";
import { getClientSession } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: {
    default: "TravelPlatform — Book Flights, Hotels & Cars",
    template: "%s | TravelPlatform",
  },
  description:
    "AI-powered travel booking. Search and book flights, hotels, and car rentals in one place.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const initialSession = await getClientSession();

  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col bg-neutral-50">
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
