/**
 * Account area layout (WO-069, AC1).
 *
 * Protected by middleware (already matches /account/* prefix).
 * Renders sidebar navigation shared across all account segments.
 * Session is fetched server-side for a flash-free first paint.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session.js";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const NAV_ITEMS = [
  { href: "/account/trips", label: "My trips", icon: "✈" },
  { href: "/account/wishlist", label: "Wishlist", icon: "♡" },
  { href: "/account/profile", label: "Profile", icon: "◉" },
  { href: "/account/security", label: "Password & security", icon: "⬡" },
];

export default async function AccountLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) {
    // Middleware handles most cases; this is a safety net for direct renders
    redirect("/sign-in?returnTo=/account/trips");
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
        {/* Sidebar navigation */}
        <nav
          aria-label="Account navigation"
          className="w-full sm:w-48 flex-shrink-0"
        >
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            My account
          </div>
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <span aria-hidden className="text-base">{item.icon}</span>
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* Main content */}
        <main className="min-w-0 flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}
