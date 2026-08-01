/**
 * Funnel pseudonymisation (WO-106 AC4).
 *
 * Produces a stable HMAC-SHA256 digest of a subject identifier (userId or
 * anonymous session id) keyed by FUNNEL_PSEUDONYM_KEY from Secrets Manager.
 *
 * Properties:
 *   - Deterministic: same input + same key always → same digest.
 *   - Non-reversible: SHA-256 HMAC cannot be inverted without the key.
 *   - Key-dependent: rotating the key produces a different digest, breaking
 *     long-term linkability (key-rotation path documented in WO-110).
 *   - Key validation: rejects absent, empty, and placeholder values at startup
 *     via the existing secretValidator assertSecretsOrExit() mechanism.
 *
 * PII invariant: the raw subject identifier never leaves this module; only the
 * hex-encoded digest is returned.
 */

import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Module-level key cache (loaded once at startup by initPseudonymKey)
// ---------------------------------------------------------------------------

let _pseudonymKey: string | undefined;

/**
 * Load the pseudonym key at service startup.  Call this once before any
 * pseudonymise() call; the key is cached in module scope for the process lifetime.
 *
 * Throws if the key is absent or empty (checked by secretValidator earlier in
 * the startup sequence, so this is a defensive belt-and-braces check).
 */
export function initPseudonymKey(key: string): void {
  if (!key || key.trim().length === 0) {
    throw new Error("FUNNEL_PSEUDONYM_KEY must not be empty");
  }
  _pseudonymKey = key;
}

/**
 * Return the loaded pseudonym key.  Throws if not yet initialised.
 * Exposed for testing via initPseudonymKey(); not exported from the package barrel.
 */
function loadKey(): string {
  if (!_pseudonymKey) {
    throw new Error(
      "FUNNEL_PSEUDONYM_KEY not initialised — call initPseudonymKey() at startup",
    );
  }
  return _pseudonymKey;
}

/**
 * Produce a stable, non-reversible HMAC-SHA256 pseudonym for a subject.
 *
 * @param subjectId  Raw userId (UUID string) or anonymous session id.
 * @param keyOverride  Optional key override for testing (skips module cache).
 * @returns Hex-encoded 64-character HMAC digest.
 */
export function pseudonymise(subjectId: string, keyOverride?: string): string {
  const key = keyOverride ?? loadKey();
  return createHmac("sha256", key).update(subjectId, "utf8").digest("hex");
}

/**
 * Reset the module key cache (test-only).
 */
export function _resetPseudonymKey(): void {
  _pseudonymKey = undefined;
}
