/**
 * Ephemeral RSA key pairs generated at test runtime with node:crypto.
 *
 * No real AWS credentials are used. Key material is generated fresh for each
 * test run and is never committed to the repository.
 */
import { generateKeyPairSync } from 'node:crypto';

export interface TestKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  activatedAt: string;
  version: string;
}

function generateTestKeyPair(version: string, activatedAt: string): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  return {
    privateKeyPem: privateKey as string,
    publicKeyPem: publicKey as string,
    activatedAt,
    version,
  };
}

// Generated once per test file import so tests that import this file share the
// same key material within a test run.
export const KEY_PAIR_V1 = generateTestKeyPair('v1', '2025-01-01T00:00:00.000Z');
export const KEY_PAIR_V2 = generateTestKeyPair('v2', '2025-06-01T00:00:00.000Z');
export const KEY_PAIR_V3 = generateTestKeyPair('v3', '2025-12-01T00:00:00.000Z');
