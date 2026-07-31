/**
 * Integration tests for the root layout shell.
 *
 * Tests the SiteHeader, SiteFooter, and MobileNavDrawer components in
 * isolation (not the full App Router layout, which requires Next.js internals).
 *
 * MSW is available via test/setup.ts if needed.
 */

import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// Mock Next.js navigation hooks — not available outside the Next.js runtime
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className, ...props }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  ),
}));

import { SiteHeader } from "../../components/layout/SiteHeader.js";
import { SiteFooter } from "../../components/layout/SiteFooter.js";
import { MobileNavDrawer } from "../../components/layout/MobileNavDrawer.js";
import { ToastProvider } from "../../components/ui/Toast.js";
import { SessionProvider } from "../../lib/auth/context.js";

/** Wrap a component with all required providers for testing. */
function withProviders(ui: React.ReactElement) {
  return render(
    <SessionProvider initialSession={null}>
      {ui}
    </SessionProvider>,
  );
}

// ---------------------------------------------------------------------------
// SiteHeader
// ---------------------------------------------------------------------------

describe("SiteHeader", () => {
  it("renders the logo link", () => {
    withProviders(<SiteHeader />);
    const logo = screen.getByRole("link", { name: /TravelPlatform home/i });
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("href", "/");
  });

  it("renders the primary navigation on desktop", () => {
    withProviders(<SiteHeader />);
    const nav = screen.getByRole("navigation", { name: /Primary navigation/i });
    expect(nav).toBeInTheDocument();
  });

  it("renders the sign-in link when unauthenticated", () => {
    withProviders(<SiteHeader />);
    expect(screen.getByRole("link", { name: /Sign in/i })).toBeInTheDocument();
  });

  it("renders hamburger menu button for mobile", () => {
    withProviders(<SiteHeader />);
    const hamburger = screen.getByRole("button", { name: /Open navigation menu/i });
    expect(hamburger).toBeInTheDocument();
    expect(hamburger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens mobile nav drawer when hamburger is clicked", async () => {
    withProviders(<SiteHeader />);
    const hamburger = screen.getByRole("button", { name: /Open navigation menu/i });
    await userEvent.click(hamburger);
    expect(hamburger).toHaveAttribute("aria-expanded", "true");
  });
});

// ---------------------------------------------------------------------------
// SiteFooter
// ---------------------------------------------------------------------------

describe("SiteFooter", () => {
  it("renders contentinfo landmark", () => {
    render(<SiteFooter />);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("renders the legal navigation", () => {
    render(<SiteFooter />);
    expect(screen.getByRole("navigation", { name: /Legal links/i })).toBeInTheDocument();
  });

  it("renders Privacy Policy link", () => {
    render(<SiteFooter />);
    expect(screen.getByRole("link", { name: /Privacy Policy/i })).toBeInTheDocument();
  });

  it("renders Terms of Service link", () => {
    render(<SiteFooter />);
    expect(screen.getByRole("link", { name: /Terms of Service/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// MobileNavDrawer
// ---------------------------------------------------------------------------

describe("MobileNavDrawer", () => {
  const NAV_ITEMS = [
    { label: "Search Flights", href: "/search?tab=FLIGHT" },
    { label: "My Trips", href: "/profile" },
  ] as const;

  it("is closed by default when open=false", () => {
    render(
      <ToastProvider>
        <MobileNavDrawer
          open={false}
          onOpenChange={vi.fn()}
          navItems={NAV_ITEMS}
        />
      </ToastProvider>,
    );
    // Dialog is not in the DOM when closed
    expect(screen.queryByRole("navigation", { name: /Mobile navigation/i })).not.toBeInTheDocument();
  });

  it("renders navigation links when open=true", () => {
    render(
      <ToastProvider>
        <MobileNavDrawer
          open={true}
          onOpenChange={vi.fn()}
          navItems={NAV_ITEMS}
        />
      </ToastProvider>,
    );
    expect(screen.getByRole("navigation", { name: /Mobile navigation/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Search Flights" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My Trips" })).toBeInTheDocument();
  });

  it("closes when Escape is pressed", async () => {
    const onOpenChange = vi.fn();
    render(
      <ToastProvider>
        <MobileNavDrawer
          open={true}
          onOpenChange={onOpenChange}
          navItems={NAV_ITEMS}
        />
      </ToastProvider>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
