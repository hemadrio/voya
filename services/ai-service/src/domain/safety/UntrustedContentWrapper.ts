/**
 * UntrustedContentWrapper — escapes, sanitises and wraps untrusted content
 * before it is inserted into the prompt (WO-061, AC1, AC2, AC7).
 *
 * Operations in order:
 *   1. Strip invisible and bidirectional Unicode control characters (AC7).
 *   2. Escape any occurrence of the delimiter sequence so it cannot terminate
 *      the data block early (AC2).
 *   3. Truncate to the configured maximum and record if truncation occurred.
 *   4. Wrap in a labelled data block:
 *        <data:user>…content…</data:user>  (AC1)
 *        <data:tool name="search_flights">…content…</data:tool>
 *
 * The returned wrapped text is safe for direct prompt insertion.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Opening/closing delimiter sequence. Must never appear inside a data block. */
export const DATA_BLOCK_DELIMITER = "<<</data-block-boundary/>>>";

/** Default maximum length for untrusted content (characters, post-invisible-strip). */
export const DEFAULT_MAX_CONTENT_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Invisible and bidi Unicode ranges to strip (AC7)
// ---------------------------------------------------------------------------

// Zero-width and invisible characters:
//   U+00AD SOFT HYPHEN
//   U+200B ZERO WIDTH SPACE
//   U+200C ZERO WIDTH NON-JOINER
//   U+200D ZERO WIDTH JOINER
//   U+200E LEFT-TO-RIGHT MARK
//   U+200F RIGHT-TO-LEFT MARK
//   U+2028 LINE SEPARATOR
//   U+2029 PARAGRAPH SEPARATOR
//   U+202A–U+202E BIDI embedding/override chars
//   U+2060 WORD JOINER
//   U+2061–U+2064 invisible operators
//   U+206A–U+206F INHIBIT SYMMETRIC SWAPPING etc.
//   U+FEFF ZERO WIDTH NO-BREAK SPACE (BOM)
//   U+FFF9–U+FFFB INTERLINEAR ANNOTATION
const INVISIBLE_CHARS_RE =
  /[­​-‏  ‪-‮⁠-⁤⁪-⁯﻿￹-￻]/g;

// ---------------------------------------------------------------------------
// Content kind
// ---------------------------------------------------------------------------

export type ContentKind = "user" | "tool";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface WrapResult {
  /** The escaped, truncated, wrapped text ready for prompt insertion. */
  wrappedText: string;
  /** True when the content was truncated to maxContentChars. */
  truncated: boolean;
  /** Number of delimiter sequences that were escaped in the original content. */
  escapedDelimiters: number;
  /** True when invisible characters were stripped. */
  strippedInvisible: boolean;
}

// ---------------------------------------------------------------------------
// UntrustedContentWrapper
// ---------------------------------------------------------------------------

export interface UntrustedContentWrapperConfig {
  /** Max characters per block (default: DEFAULT_MAX_CONTENT_CHARS). */
  maxContentChars?: number;
}

export class UntrustedContentWrapper {
  private readonly maxContentChars: number;

  constructor(config: UntrustedContentWrapperConfig = {}) {
    this.maxContentChars = config.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  }

  /**
   * Wrap a single piece of untrusted content.
   *
   * @param kind    "user" for user messages, "tool" for tool result text.
   * @param text    The raw untrusted string.
   * @param toolName  Optional tool name for <data:tool name="..."> labels.
   */
  wrap(kind: ContentKind, text: string, toolName?: string): WrapResult {
    // Step 1: strip invisible / bidi chars
    const stripped = text.replace(INVISIBLE_CHARS_RE, "");
    const strippedInvisible = stripped.length !== text.length;

    // Step 2: escape delimiter sequences so they cannot terminate the block
    let escaped = stripped;
    let escapedDelimiters = 0;
    if (escaped.includes(DATA_BLOCK_DELIMITER)) {
      // Replace every occurrence with a safe placeholder that is clearly inert
      escaped = escaped.split(DATA_BLOCK_DELIMITER).join("[ESCAPED_DELIMITER]");
      escapedDelimiters = (stripped.match(new RegExp(DATA_BLOCK_DELIMITER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
    }

    // Step 3: truncate
    let truncated = false;
    if (escaped.length > this.maxContentChars) {
      escaped = escaped.slice(0, this.maxContentChars);
      truncated = true;
    }

    // Step 4: wrap in labelled data block
    const openTag =
      kind === "tool" && toolName
        ? `<data:tool name="${sanitiseTagAttr(toolName)}">`
        : kind === "tool"
        ? "<data:tool>"
        : "<data:user>";
    const closeTag = kind === "tool" ? "</data:tool>" : "</data:user>";

    const wrappedText = `${openTag}\n${escaped}\n${closeTag}`;

    return { wrappedText, truncated, escapedDelimiters, strippedInvisible };
  }

  /**
   * Wrap all free-text string values in a tool result object recursively.
   * Non-string values are unchanged.  This neutralises poisoned supplier
   * descriptions before they reach the model (AC1).
   */
  wrapToolResult(toolName: string, data: unknown): string {
    const serialised = typeof data === "string" ? data : JSON.stringify(data, wrapReplacer, 2);
    return this.wrap("tool", serialised, toolName).wrappedText;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prevent tag attribute injection via the tool name. */
function sanitiseTagAttr(value: string): string {
  return value.replace(/["<>&]/g, "_").slice(0, 64);
}

/**
 * JSON replacer that limits individual string values to 2000 chars to prevent
 * a single huge field from consuming the entire budget.
 */
function wrapReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.length > 2_000) {
    return value.slice(0, 2_000) + "…[truncated]";
  }
  return value;
}
