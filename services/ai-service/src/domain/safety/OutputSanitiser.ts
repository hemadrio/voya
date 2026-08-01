/**
 * OutputSanitiser — strips executable markup, dangerous URI schemes, and
 * invisible characters from assistant output text (WO-061, AC5, AC6, AC7).
 *
 * Applied server-side before any text is emitted to the client.  Client-side
 * escaping is not the primary control (Constraints).
 *
 * Operations:
 *   1. Strip invisible / bidi Unicode control characters (AC7).
 *   2. Remove <script>…</script> blocks (AC5).
 *   3. Remove HTML event handler attributes (onclick=, onload=, …) (AC5).
 *   4. Replace dangerous URI schemes (javascript:, data:, vbscript:) with
 *      the literal text "[unsafe-uri]" (AC5).
 *   5. Strip remaining HTML tags except a minimal safe subset (AC5).
 *   6. Enforce link host allow-list: markdown [text](url) links with a host
 *      not on the allow-list are rendered as inert text (AC6).
 *
 * Returns { safeText, actions } where actions enumerates removals by kind
 * for telemetry (AC9).
 *
 * Streaming safety: call sanitise() on each complete buffered segment.
 * The orchestrator already buffers per grounding round before emitting, so
 * dangerous sequences cannot be split across deltas.
 */

// ---------------------------------------------------------------------------
// Action kinds
// ---------------------------------------------------------------------------

export type SanitisationActionKind =
  | "script_removed"
  | "event_handler_removed"
  | "dangerous_uri_scheme_removed"
  | "disallowed_link_host_inerted"
  | "html_stripped"
  | "invisible_chars_stripped";

export interface SanitisationAction {
  kind: SanitisationActionKind;
  count: number;
}

export interface SanitisationResult {
  safeText: string;
  actions: SanitisationAction[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default allow-listed link schemes. Only https links are ever clickable. */
const DEFAULT_ALLOWED_SCHEMES: readonly string[] = ["https", "http"];

/**
 * Default allow-listed link hosts.  Override at construction time to add
 * first-party supplier hosts.  An empty allow-list means ALL hosts are
 * inerted (useful for maximum restriction).
 */
const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  "www.amadeus.com",
  "amadeus.com",
  "www.booking.com",
  "booking.com",
];

export interface OutputSanitiserConfig {
  /** Allowed URI schemes for links. Default: ["https", "http"]. */
  allowedSchemes?: readonly string[];
  /**
   * Allowed link hosts.  A link whose host is not in this list is rendered
   * as inert text (no clickable URL).  Pass an empty array to allow all
   * https/http links through (not recommended for production).
   */
  allowedHosts?: readonly string[];
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// <script>…</script> — case-insensitive, any content including newlines
const SCRIPT_TAG_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;

// HTML event handler attributes: onXxx="…" or onXxx=… (unquoted)
const EVENT_HANDLER_RE = /\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi;

// Dangerous URI schemes — match the scheme portion before ':'
// Covers javascript:, data:, vbscript:, and less-common variants
const DANGEROUS_URI_SCHEME_RE = /\b(javascript|data|vbscript|file|blob)\s*:/gi;

// Same as UntrustedContentWrapper — strip invisible and bidi chars
const INVISIBLE_CHARS_RE =
  /[­​-‏  ‪-‮⁠-⁤⁪-⁯﻿￹-￻]/g;

// Remaining HTML tags after script removal — strip them
// Safe subset kept: none (plain text only in AI output)
const HTML_TAG_RE = /<[^>]+>/g;

// Markdown links: [text](url) — capture groups 1=text, 2=url
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

// ---------------------------------------------------------------------------
// OutputSanitiser
// ---------------------------------------------------------------------------

export class OutputSanitiser {
  private readonly allowedSchemes: ReadonlySet<string>;
  private readonly allowedHosts: ReadonlySet<string>;

  constructor(config: OutputSanitiserConfig = {}) {
    this.allowedSchemes = new Set(
      (config.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES).map((s) => s.toLowerCase()),
    );
    this.allowedHosts = new Set(
      (config.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map((h) => h.toLowerCase()),
    );
  }

  sanitise(text: string): SanitisationResult {
    const counters = new Map<SanitisationActionKind, number>();
    const inc = (kind: SanitisationActionKind, n = 1) =>
      counters.set(kind, (counters.get(kind) ?? 0) + n);

    let out = text;

    // Step 1: strip invisible / bidi chars
    const afterInvisible = out.replace(INVISIBLE_CHARS_RE, "");
    if (afterInvisible.length !== out.length) {
      inc("invisible_chars_stripped", out.length - afterInvisible.length);
    }
    out = afterInvisible;

    // Step 2: remove <script>…</script>
    const afterScript = out.replace(SCRIPT_TAG_RE, (match) => {
      inc("script_removed");
      return `[script-removed]`;
    });
    out = afterScript;

    // Step 3: remove HTML event handlers
    const afterHandlers = out.replace(EVENT_HANDLER_RE, (match) => {
      inc("event_handler_removed");
      return "";
    });
    out = afterHandlers;

    // Step 4: neutralise dangerous URI schemes
    // Applied before HTML tag stripping so href="javascript:..." is caught
    const afterDangerousUri = out.replace(DANGEROUS_URI_SCHEME_RE, (match, scheme) => {
      inc("dangerous_uri_scheme_removed");
      return "[unsafe-uri]:";
    });
    out = afterDangerousUri;

    // Step 5: strip remaining HTML tags
    const afterTags = out.replace(HTML_TAG_RE, (match) => {
      inc("html_stripped");
      return "";
    });
    out = afterTags;

    // Step 6: enforce link host allow-list on markdown links
    out = out.replace(MD_LINK_RE, (match, linkText: string, url: string) => {
      const trimmedUrl = url.trim();
      // Already flagged as unsafe URI
      if (trimmedUrl.startsWith("[unsafe-uri]:")) {
        inc("disallowed_link_host_inerted");
        return linkText; // render as inert plain text
      }

      // Parse scheme and host
      const schemeMatch = trimmedUrl.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):\/\/([^/?#]*)/);
      if (!schemeMatch) {
        // Relative or unrecognised — inert
        inc("disallowed_link_host_inerted");
        return linkText;
      }

      const scheme = schemeMatch[1].toLowerCase();
      const host = schemeMatch[2].toLowerCase().replace(/^www\./, "");

      if (!this.allowedSchemes.has(scheme)) {
        inc("dangerous_uri_scheme_removed");
        return linkText;
      }

      // If allowedHosts is non-empty, the host must be in the list
      if (
        this.allowedHosts.size > 0 &&
        !this.allowedHosts.has(schemeMatch[2].toLowerCase()) &&
        !this.allowedHosts.has(host)
      ) {
        inc("disallowed_link_host_inerted");
        return linkText; // render as inert text, no URL
      }

      return match; // allow through
    });

    const actions: SanitisationAction[] = Array.from(counters.entries())
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => ({ kind, count }));

    return { safeText: out, actions };
  }
}
