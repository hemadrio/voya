import * as React from "react";
import Link from "next/link";

const LEGAL_LINKS = [
  { label: "Privacy Policy", href: "/legal/privacy" },
  { label: "Terms of Service", href: "/legal/terms" },
  { label: "Cookie Policy", href: "/legal/cookies" },
  { label: "Accessibility", href: "/legal/accessibility" },
] as const;

function SiteFooter() {
  return (
    <footer
      className="border-t border-neutral-200 bg-white"
      role="contentinfo"
    >
      <div className="mx-auto max-w-[80rem] px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
          {/* Brand */}
          <p className="text-sm font-semibold text-neutral-700">
            TravelPlatform
          </p>

          {/* Legal navigation */}
          <nav aria-label="Legal links">
            <ul className="flex flex-wrap justify-center gap-x-6 gap-y-2" role="list">
              {LEGAL_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-xs text-neutral-500 hover:text-neutral-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* Copyright */}
          <p className="text-xs text-neutral-400">
            &copy; {new Date().getFullYear()} TravelPlatform. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}

export { SiteFooter };
