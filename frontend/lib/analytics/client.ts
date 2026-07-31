/**
 * Analytics batching client.
 *
 * Batches events in memory and flushes:
 *   - When the batch size reaches MAX_BATCH_SIZE
 *   - On `visibilitychange` to "hidden" (page hide / tab switch)
 *   - On `pagehide` event (back-forward cache, mobile)
 *
 * Transport uses sendBeacon with a fetch fallback.
 * All failures are swallowed silently — instrumentation must never
 * break the funnel (AC11 constraint).
 *
 * PII scrubbing via scrubEvent() is applied before queueing.
 */

import type { AnalyticsEvent } from "./events";
import { scrubEvent } from "./events";

const ENDPOINT =
  process.env["NEXT_PUBLIC_ANALYTICS_ENDPOINT"] ?? "/api/analytics/events";
const MAX_BATCH_SIZE = 10;
const MAX_RETRY = 2;

let _queue: AnalyticsEvent[] = [];
let _flushScheduled = false;

function getQueue(): AnalyticsEvent[] {
  return _queue;
}

// ---------------------------------------------------------------------------
// Core queue operations
// ---------------------------------------------------------------------------

/**
 * Enqueue an analytics event. Scrubs PII before adding to the queue.
 * Triggers an immediate flush if the batch is full.
 */
export function trackEvent(event: AnalyticsEvent): void {
  const scrubbed: AnalyticsEvent = {
    ...event,
    properties: scrubEvent(event.properties as Record<string, unknown>) as AnalyticsEvent["properties"],
  };

  _queue.push(scrubbed);

  if (_queue.length >= MAX_BATCH_SIZE) {
    void flushEvents();
    return;
  }

  // Schedule a deferred flush so rapid sequential events are batched together
  if (!_flushScheduled) {
    _flushScheduled = true;
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(() => {
        _flushScheduled = false;
        void flushEvents();
      });
    } else {
      setTimeout(() => {
        _flushScheduled = false;
        void flushEvents();
      }, 500);
    }
  }
}

/**
 * Flush all queued events to the analytics endpoint.
 *
 * Uses sendBeacon where available (reliable on page hide),
 * falls back to fetch with retry for normal flushes.
 */
export async function flushEvents(): Promise<void> {
  if (_queue.length === 0) return;

  const batch = _queue.slice();
  _queue = [];

  const payload = JSON.stringify({ events: batch });

  // sendBeacon — preferred for page-hide flushes (fire-and-forget, reliable)
  if (typeof navigator !== "undefined" && navigator.sendBeacon !== undefined) {
    const blob = new Blob([payload], { type: "application/json" });
    const sent = navigator.sendBeacon(ENDPOINT, blob);
    if (sent) return;
    // sendBeacon returned false (quota exceeded) — fall through to fetch
  }

  // fetch with bounded retry
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
      });
      if (res.ok) return;
    } catch {
      // Network failure — retry or give up silently
    }
    // Exponential back-off: 200ms, 400ms
    await new Promise<void>((resolve) =>
      setTimeout(resolve, 200 * Math.pow(2, attempt)),
    );
  }

  // After MAX_RETRY failures: events are dropped silently per error-handling spec
}

// ---------------------------------------------------------------------------
// Page-hide / visibility flush
// ---------------------------------------------------------------------------

/**
 * Register page-hide listeners that flush the queue when the page is hidden
 * or the user navigates away. Call once during app initialization.
 *
 * Safe to call in SSR environments (no-ops if window is unavailable).
 */
export function registerPageHideFlush(): void {
  if (typeof window === "undefined") return;

  const handleHide = () => {
    if (_queue.length > 0) {
      // Use sendBeacon synchronously on page hide — no await needed
      const payload = JSON.stringify({ events: _queue });
      const blob = new Blob([payload], { type: "application/json" });
      const sent =
        navigator.sendBeacon !== undefined && navigator.sendBeacon(ENDPOINT, blob);
      if (sent) {
        _queue = [];
      }
    }
  };

  window.addEventListener("pagehide", handleHide);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") handleHide();
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset the queue — used in tests to ensure isolation. */
export function _resetQueue(): void {
  _queue = [];
  _flushScheduled = false;
}

/** Inspect the current queue — read-only snapshot for tests. */
export function _getQueue(): readonly AnalyticsEvent[] {
  return getQueue();
}
