/**
 * PII redaction for conversation content (WO-057).
 *
 * Applied to user and assistant message content before persistence so that
 * accidental PII never reaches the database.
 *
 * Rules:
 *   - Card-like digit sequences (13–19 contiguous digits, with optional
 *     spaces or dashes every 4 digits) are replaced with [REDACTED_CARD].
 *   - Email addresses are replaced with [REDACTED_EMAIL].
 */

// Matches 13–19 digit runs that look like payment card numbers.
// Accepts raw digits or groups separated by single spaces or hyphens.
const CARD_PATTERN =
  /\b(?:\d{4}[-\s]?){2,4}\d{1,4}\b(?!\.\d)/g;

// Matches standard email addresses.
const EMAIL_PATTERN = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

/**
 * Return a redacted copy of content with card-like numbers and email
 * addresses masked.  The original string is not mutated.
 *
 * Only sequences that actually look like card numbers (13–19 total digits)
 * are masked; shorter digit runs (phone numbers, zip codes, etc.) are left
 * intact.
 */
export function redact(content: string): string {
  return content
    .replace(CARD_PATTERN, (match) => {
      // Count total digits in the match to confirm it is card-length.
      const digits = match.replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 19) return match;
      return '[REDACTED_CARD]';
    })
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
}
