/**
 * SettlementWindowService — runtime-configurable settlement window wording (WO-049 AC7).
 *
 * The pending legal decision on refund wording (Q9) must not block delivery.
 * This service reads wording from a configurable template keyed by
 * (provider, currency) so the strings can be updated without redeployment
 * by pushing a config change (environment variable or injected map).
 *
 * Default fallback: "Refunds are typically processed within 5–10 business days."
 *
 * Environment variable override (optional):
 *   SETTLEMENT_WINDOW_TEMPLATES — JSON-encoded Record<"provider:CURRENCY", string>
 *   e.g. '{"stripe:USD":"Refunds appear in 5–10 business days","stripe:EUR":"..."}'
 */

import type { SettlementWindowPort } from "./RefundService.js";

// ---------------------------------------------------------------------------
// Default templates (pending legal sign-off on Q9)
// ---------------------------------------------------------------------------

const DEFAULT_TEMPLATE = "Refunds are typically processed within 5–10 business days.";

const BUILT_IN_TEMPLATES: Record<string, string> = {
  "stripe:USD": "Refunds typically appear on your statement within 5–10 business days.",
  "stripe:EUR": "Refunds are typically processed within 5–10 business days.",
  "stripe:GBP": "Refunds are typically processed within 3–5 business days.",
};

// ---------------------------------------------------------------------------
// SettlementWindowService
// ---------------------------------------------------------------------------

export class SettlementWindowService implements SettlementWindowPort {
  private readonly templates: Record<string, string>;

  constructor(overrides?: Record<string, string>) {
    let envTemplates: Record<string, string> = {};
    const raw = process.env["SETTLEMENT_WINDOW_TEMPLATES"];
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === "object" && parsed !== null) {
          envTemplates = parsed as Record<string, string>;
        }
      } catch {
        // Invalid JSON — fall back to built-in templates
      }
    }
    // Priority: caller-supplied overrides > env overrides > built-in defaults
    this.templates = { ...BUILT_IN_TEMPLATES, ...envTemplates, ...(overrides ?? {}) };
  }

  async lookup(provider: string, currency: string): Promise<string> {
    const key = `${provider.toLowerCase()}:${currency.toUpperCase()}`;
    return this.templates[key] ?? DEFAULT_TEMPLATE;
  }
}
