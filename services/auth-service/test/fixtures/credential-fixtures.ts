/**
 * Known password/hash pairs for unit and integration tests.
 *
 * ALL values were produced by CredentialService.hashPassword() with
 * the test config (N=1024, r=8, p=1, keyLen=64).
 *
 * DO NOT use these hashes in production — they use deliberately low cost.
 */

/** A valid password that passes all policy rules. */
export const VALID_PASSWORD = 'GoodPassword!99';

/** The legacy scrypt:<salt>:<hash> format (produced by crypto/password.ts). */
export const LEGACY_HASH_FORMAT_MARKER = 'scrypt:';

/** Passwords that must be rejected by the common-password rule. */
export const COMMON_PASSWORDS = [
  'password',
  'password123',
  '123456',
  'qwerty',
  'admin',
];

/** Passwords that must pass all policy rules (boundary cases). */
export const BOUNDARY_VALID = [
  'A'.repeat(12),   // exactly minLength
  'A'.repeat(128),  // exactly maxLength
  'abcdefghijk!1',  // 12 chars, not common, no email part
];

/** Passwords that must fail the MIN_LENGTH rule. */
export const TOO_SHORT = [
  '',
  'short',
  'A'.repeat(11),
];

/** A password that must fail the MAX_LENGTH rule. */
export const TOO_LONG = 'A'.repeat(129);
