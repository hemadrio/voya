"use client";

/**
 * TripTabs — tabbed booking list with keyboard arrow navigation (WO-069, AC2).
 *
 * Implements the ARIA tabs pattern: role="tablist" with arrow-key support.
 * Each tab shows a booking count badge and the active tab renders its content.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils.js";
import { TAB_LABELS } from "@/lib/bookings/status.js";
import type { TripTab } from "@/lib/bookings/status.js";
import { BookingCard } from "./BookingCard.js";
import type { BookingListItem } from "@/lib/api/account.js";

export const TRIP_TABS: TripTab[] = ["upcoming", "in_progress", "past", "cancelled"];

interface TripTabsProps {
  /** Pre-loaded bookings per tab. Keys with no entry show an empty state. */
  bookingsByTab: Partial<Record<TripTab, BookingListItem[]>>;
  /** Total pages per tab for pagination UI */
  totalPagesByTab?: Partial<Record<TripTab, number>>;
  /** Called when a tab needs another page */
  onLoadMore?: (tab: TripTab, page: number) => void;
  loadingMore?: TripTab | null;
  initialTab?: TripTab;
}

export function TripTabs({
  bookingsByTab,
  totalPagesByTab = {},
  onLoadMore,
  loadingMore = null,
  initialTab = "upcoming",
}: TripTabsProps) {
  const [activeTab, setActiveTab] = useState<TripTab>(initialTab);
  const [pages, setPages] = useState<Partial<Record<TripTab, number>>>({});
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const handleTabSelect = useCallback((tab: TripTab) => {
    setActiveTab(tab);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      let next = index;
      if (e.key === "ArrowRight") next = (index + 1) % TRIP_TABS.length;
      else if (e.key === "ArrowLeft") next = (index - 1 + TRIP_TABS.length) % TRIP_TABS.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = TRIP_TABS.length - 1;
      else return;
      e.preventDefault();
      tabRefs.current[next]?.focus();
      setActiveTab(TRIP_TABS[next]);
    },
    [],
  );

  const items = bookingsByTab[activeTab] ?? [];
  const totalPages = totalPagesByTab[activeTab] ?? 1;
  const currentPage = pages[activeTab] ?? 1;

  function handleLoadMore() {
    const nextPage = currentPage + 1;
    setPages((p) => ({ ...p, [activeTab]: nextPage }));
    onLoadMore?.(activeTab, nextPage);
  }

  return (
    <div>
      {/* Tablist */}
      <div role="tablist" aria-label="Trip categories" className="flex border-b border-neutral-200">
        {TRIP_TABS.map((tab, i) => {
          const count = bookingsByTab[tab]?.length ?? 0;
          const isActive = tab === activeTab;
          return (
            <button
              key={tab}
              id={`tab-${tab}`}
              role="tab"
              aria-selected={isActive}
              aria-controls={`tabpanel-${tab}`}
              ref={(el) => { tabRefs.current[i] = el; }}
              tabIndex={isActive ? 0 : -1}
              onClick={() => handleTabSelect(tab)}
              onKeyDown={(e) => handleKeyDown(e, i)}
              className={cn(
                "flex items-center gap-1.5 px-4 py-3 text-sm font-medium transition-colors",
                isActive
                  ? "border-b-2 border-brand-600 text-brand-700"
                  : "text-neutral-500 hover:text-neutral-700",
              )}
            >
              {TAB_LABELS[tab]}
              {count > 0 && (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-xs font-semibold",
                    isActive ? "bg-brand-100 text-brand-700" : "bg-neutral-100 text-neutral-500",
                  )}
                  aria-label={`${count} booking${count !== 1 ? "s" : ""}`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab panels */}
      {TRIP_TABS.map((tab) => (
        <div
          key={tab}
          id={`tabpanel-${tab}`}
          role="tabpanel"
          aria-labelledby={`tab-${tab}`}
          hidden={tab !== activeTab}
        >
          {tab === activeTab && (
            <div className="py-4">
              {items.length === 0 ? (
                <EmptyTabState tab={tab} />
              ) : (
                <div className="space-y-3">
                  {items.map((booking) => (
                    <BookingCard key={booking.bookingId} booking={booking} />
                  ))}

                  {currentPage < totalPages && (
                    <div className="pt-2 text-center">
                      <button
                        type="button"
                        onClick={handleLoadMore}
                        disabled={loadingMore === activeTab}
                        className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                      >
                        {loadingMore === activeTab ? "Loading…" : "Load more"}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function EmptyTabState({ tab }: { tab: TripTab }) {
  const messages: Record<TripTab, { heading: string; body: string; cta?: string; ctaHref?: string }> = {
    upcoming: {
      heading: "No upcoming trips",
      body: "Ready for your next adventure? Browse our listings and book a stay.",
      cta: "Explore listings",
      ctaHref: "/search",
    },
    in_progress: {
      heading: "No active stays",
      body: "You don't have any stays in progress right now.",
    },
    past: {
      heading: "No past trips",
      body: "Completed stays will appear here.",
    },
    cancelled: {
      heading: "No cancelled bookings",
      body: "Cancelled bookings will appear here.",
    },
  };

  const { heading, body, cta, ctaHref } = messages[tab];

  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <p className="text-base font-medium text-neutral-700">{heading}</p>
      <p className="max-w-xs text-sm text-neutral-500">{body}</p>
      {cta && ctaHref && (
        <a
          href={ctaHref}
          className="mt-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          {cta}
        </a>
      )}
    </div>
  );
}
