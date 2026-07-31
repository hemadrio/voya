/**
 * Client-side error reporter with PII scrubbing.
 *
 * Captures unhandled errors and React error boundary reports,
 * enriches them with release/route context, scrubs sensitive fields,
 * and sends to the error tracking endpoint.
 *
 * Constraints (AC10):
 * - Email addresses, tokens, and payment data must be scrubbed before sending.
 * - Source maps are uploaded at build time; they are NOT served publicly.
 * - Failures are swallowed silently — the reporter must never break the funnel.
 */

const ERROR_ENDPOINT =
  process.env["NEXT_PUBLIC_ERROR_ENDPOINT"] ?? "/api/observability/errors";

const RELEASE = process.env["NEXT_PUBLIC_APP_RELEASE"] ?? "unknown";

// ---------------------------------------------------------------------------
// PII scrubbing patterns
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
const TOKEN_PATTERN = /\b(Bearer\s+)?[A-Za-z0-9_\-]{20,}\b/g;
const CARD_PATTERN = /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g;
const CVV_PATTERN = /\b\d{3,4}\b/g;

// Keys whose values must be fully redacted
const REDACT_KEYS = new Set([
  "password",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "cookie",
  "sessionid",
  "session_id",
  "secret",
  "cardnumber",
  "card_number",
  "cvv",
  "cvc",
  "pan",
  "iban",
  "email",
]);

export function scrubString(value: string): string {
  return value
    .replace(EMAIL_PATTERN, "[email]")
    .replace(CARD_PATTERN, "[card]")
    .replace(TOKEN_PATTERN, "[token]");
}

export function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (REDACT_KEYS.has(lowerKey)) {
      result[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string") {
      result[key] = scrubString(value);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = scrubObject(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Error report shape
// ---------------------------------------------------------------------------

export interface ErrorReport {
  message: string;
  stack?: string;
  componentStack?: string;
  route: string;
  release: string;
  deviceType: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Build an error report
// ---------------------------------------------------------------------------

export function buildErrorReport(
  error: Error,
  options: {
    route?: string;
    componentStack?: string;
    context?: Record<string, unknown>;
  } = {},
): ErrorReport {
  const deviceType =
    typeof navigator !== "undefined"
      ? /mobile/i.test(navigator.userAgent)
        ? "mobile"
        : "desktop"
      : "server";

  const raw: ErrorReport = {
    message: error.message,
    stack: error.stack,
    componentStack: options.componentStack,
    route: options.route ?? (typeof window !== "undefined" ? window.location.pathname : "unknown"),
    release: RELEASE,
    deviceType,
    timestamp: new Date().toISOString(),
    context: options.context,
  };

  // Scrub message and stack
  return {
    ...raw,
    message: scrubString(raw.message),
    stack: raw.stack !== undefined ? scrubString(raw.stack) : undefined,
    context:
      raw.context !== undefined ? scrubObject(raw.context) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Send an error report
// ---------------------------------------------------------------------------

export function reportError(
  error: Error,
  options: Parameters<typeof buildErrorReport>[1] = {},
): void {
  if (typeof window === "undefined") return;

  const report = buildErrorReport(error, options);

  try {
    if (navigator.sendBeacon !== undefined) {
      const blob = new Blob([JSON.stringify(report)], {
        type: "application/json",
      });
      const sent = navigator.sendBeacon(ERROR_ENDPOINT, blob);
      if (sent) return;
    }
    void fetch(ERROR_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      keepalive: true,
    });
  } catch {
    if (process.env["NODE_ENV"] === "development") {
      console.warn("[errorReporter] Failed to send error report:", error.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Global unhandled error registration
// ---------------------------------------------------------------------------

/**
 * Register global window.onerror and unhandledrejection listeners.
 * Call once from the client layout component.
 */
export function registerGlobalErrorHandlers(route: string): void {
  if (typeof window === "undefined") return;

  window.addEventListener("error", (event) => {
    if (event.error instanceof Error) {
      reportError(event.error, { route });
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    if (reason instanceof Error) {
      reportError(reason, { route });
    } else if (typeof reason === "string") {
      reportError(new Error(reason), { route });
    }
  });
}
