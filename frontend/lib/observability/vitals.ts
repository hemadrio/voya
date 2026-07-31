/**
 * Core Web Vitals reporter.
 *
 * Hooks into Next.js's useReportWebVitals (or can be called directly)
 * and sends metrics to the analytics endpoint with route, device, and
 * connection dimensions.
 *
 * Failures are swallowed silently — instrumentation must never break
 * the funnel (AC10 constraint).
 */

export type VitalName = "FCP" | "LCP" | "CLS" | "FID" | "INP" | "TTFB";

export interface VitalMetric {
  name: VitalName;
  value: number;
  id: string;
  rating?: "good" | "needs-improvement" | "poor";
}

export interface VitalDimensions {
  route: string;
  deviceType: "desktop" | "mobile" | "tablet";
  effectiveConnectionType?: string;
  locale?: string;
}

export interface VitalPayload {
  metric: VitalName;
  value: number;
  id: string;
  rating?: string;
  route: string;
  deviceType: string;
  connectionType?: string;
  locale?: string;
  timestamp: string;
}

const VITALS_ENDPOINT =
  process.env["NEXT_PUBLIC_VITALS_ENDPOINT"] ?? "/api/analytics/vitals";

// ---------------------------------------------------------------------------
// Device type detection
// ---------------------------------------------------------------------------

export function detectDeviceType(): "desktop" | "mobile" | "tablet" {
  if (typeof window === "undefined") return "desktop";
  const ua = navigator.userAgent;
  if (/tablet|ipad|playbook|silk/i.test(ua)) return "tablet";
  if (/mobile|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua)) return "mobile";
  return "desktop";
}

// ---------------------------------------------------------------------------
// Connection info
// ---------------------------------------------------------------------------

export function getEffectiveConnectionType(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  // Navigator.connection is non-standard but widely supported
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string };
  };
  return nav.connection?.effectiveType;
}

// ---------------------------------------------------------------------------
// Send metric via sendBeacon with fetch fallback
// ---------------------------------------------------------------------------

export function reportWebVital(metric: VitalMetric, route: string): void {
  if (typeof window === "undefined") return;

  const payload: VitalPayload = {
    metric: metric.name,
    value: metric.value,
    id: metric.id,
    rating: metric.rating,
    route,
    deviceType: detectDeviceType(),
    connectionType: getEffectiveConnectionType(),
    locale:
      typeof navigator !== "undefined" ? navigator.language : undefined,
    timestamp: new Date().toISOString(),
  };

  const body = JSON.stringify(payload);

  try {
    if (navigator.sendBeacon !== undefined) {
      const blob = new Blob([body], { type: "application/json" });
      const sent = navigator.sendBeacon(VITALS_ENDPOINT, blob);
      if (sent) return;
    }
    // sendBeacon unavailable or quota exceeded — fall back to fetch
    void fetch(VITALS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    });
  } catch {
    // Development-only log — never throws in production
    if (process.env["NODE_ENV"] === "development") {
      console.warn("[vitals] Failed to report metric:", metric.name);
    }
  }
}

// ---------------------------------------------------------------------------
// Next.js useReportWebVitals compatible handler
// ---------------------------------------------------------------------------

/**
 * Pass to Next.js useReportWebVitals() hook:
 *
 *   "use client";
 *   import { useReportWebVitals } from "next/web-vitals";
 *   import { makeVitalsHandler } from "@/lib/observability/vitals";
 *   useReportWebVitals(makeVitalsHandler(pathname));
 */
export function makeVitalsHandler(
  route: string,
): (metric: VitalMetric) => void {
  return (metric: VitalMetric) => {
    reportWebVital(metric, route);
  };
}
