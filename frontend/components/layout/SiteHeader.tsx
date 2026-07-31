"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MobileNavDrawer } from "./MobileNavDrawer.js";
import type { NavItem } from "./MobileNavDrawer.js";

const PRIMARY_NAV: ReadonlyArray<NavItem> = [
  { label: "Search Flights", href: "/search?tab=FLIGHT" },
  { label: "Search Hotels", href: "/search?tab=HOTEL" },
  { label: "Search Cars", href: "/search?tab=CAR" },
  { label: "My Trips", href: "/profile" },
];

function SiteHeader() {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  return (
    <header
      className="sticky top-0 z-[1030] h-16 border-b border-neutral-200 bg-white"
      role="banner"
    >
      <div className="mx-auto flex h-full max-w-[80rem] items-center gap-6 px-4 sm:px-6 lg:px-8">
        {/* Logo */}
        <Link
          href="/"
          className="flex-shrink-0 font-bold text-brand-700 text-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
          aria-label="Travel Platform home"
        >
          TravelPlatform
        </Link>

        {/* Primary navigation — desktop */}
        <nav
          className="hidden md:flex items-center gap-1 flex-1"
          aria-label="Primary navigation"
        >
          {PRIMARY_NAV.map((item) => {
            const isCurrent = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isCurrent ? "page" : undefined}
                title={item.label}
                className={[
                  "rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                  isCurrent
                    ? "bg-brand-50 text-brand-700"
                    : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
                ].join(" ")}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {/* Locale / currency switcher placeholder */}
          <button
            className="hidden sm:flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-label="Change locale and currency"
          >
            <span aria-hidden="true">🌐</span>
            <span>EN / USD</span>
          </button>

          {/* Auth entry point */}
          <Link
            href="/auth/login"
            className="hidden sm:inline-flex items-center rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Sign in
          </Link>

          {/* Mobile hamburger button */}
          <button
            className="flex md:hidden items-center justify-center rounded-md p-2 text-neutral-700 hover:bg-neutral-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation menu"
            aria-expanded={drawerOpen}
            aria-controls="mobile-nav-drawer"
          >
            <svg
              className="h-5 w-5"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile navigation drawer */}
      <MobileNavDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        navItems={PRIMARY_NAV}
      />
    </header>
  );
}

export { SiteHeader };
