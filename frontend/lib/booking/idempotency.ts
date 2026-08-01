/**
 * Idempotency key generation and persistence (WO-068, AC7).
 *
 * A stable UUID is generated once per draft and persisted alongside the draft.
 * The same key is reused on every create-booking attempt for the same draft so
 * refreshes, retries, or double-submits never produce duplicate bookings.
 *
 * The key is only regenerated when a draft is explicitly abandoned and restarted.
 *
 * Constraint: raw card data must never touch application code.  The idempotency
 * key is the only booking-specific data sent alongside the payment intent reference.
 */

const STORAGE_KEY = "checkout_idempotency_key";

/**
 * Generate a UUID v4 using the Web Crypto API.
 * Works in both browser and Node.js 20+ environments.
 */
function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Polyfill for environments where randomUUID is not available
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Get or create the idempotency key for the current draft.
 * Once created, the same key is returned for the lifetime of the draft in
 * this browser session.
 */
export function getOrCreateIdempotencyKey(): string {
  if (typeof sessionStorage === "undefined") {
    // SSR or unavailable — return a throwaway key (will not be persisted)
    return generateUUID();
  }
  try {
    const existing = sessionStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const key = generateUUID();
    sessionStorage.setItem(STORAGE_KEY, key);
    return key;
  } catch {
    return generateUUID();
  }
}

/**
 * Explicitly clear the idempotency key.
 * Call when a draft is abandoned and a new checkout begins.
 */
export function clearIdempotencyKey(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Peek at the current idempotency key without creating one.
 * Returns null if no key is present.
 */
export function peekIdempotencyKey(): string | null {
  try {
    return typeof sessionStorage !== "undefined"
      ? sessionStorage.getItem(STORAGE_KEY)
      : null;
  } catch {
    return null;
  }
}
