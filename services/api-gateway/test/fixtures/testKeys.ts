/**
 * RSA test key pairs for api-gateway unit tests.
 *
 * Keys are generated at module import using Node.js crypto so no real key
 * material is committed to the repository. Each test run gets fresh keys.
 * Tests that need to cross-reference the same key material should import
 * this module once and share the exports.
 */
import { generateKeyPairSync, createSign } from 'node:crypto';

export interface TestKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  version: string;
  activatedAt: string;
}

function generateRsaKeyPair(version: string, activatedAt: string): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    privateKeyPem: privateKey as string,
    publicKeyPem: publicKey as string,
    version,
    activatedAt,
  };
}

// Generated once per module import; shared within a test run
export const TEST_KEY_CURRENT = generateRsaKeyPair('v-current', '2025-06-01T00:00:00.000Z');
export const TEST_KEY_PREVIOUS = generateRsaKeyPair('v-previous', '2025-01-01T00:00:00.000Z');
export const TEST_KEY_OTHER = generateRsaKeyPair('v-other', '2024-01-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// JWT minting helper for tests
// ---------------------------------------------------------------------------

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export interface JwtClaims {
  sub?: string;
  sid?: string;
  roles?: string[];
  jti?: string;
  exp?: number;
  iat?: number;
  alg?: string;
  [key: string]: unknown;
}

/**
 * Mint a real RS256-signed JWT for testing.
 *
 * Defaults produce a valid token that expires 15 minutes from now.
 */
export function mintTestJwt(keyPair: TestKeyPair, overrides?: JwtClaims): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims: JwtClaims = {
    sub: 'usr_01J0TESTUSER',
    sid: 'ses_01J0TESTSESSION',
    roles: ['traveler'],
    jti: 'jti_01J0TESTJTI',
    iat: nowSeconds,
    exp: nowSeconds + 900, // 15 minutes
    ...overrides,
  };

  const { alg: _alg, ...payloadClaims } = claims;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(payloadClaims));
  const message = `${header}.${payload}`;

  const signer = createSign('RSA-SHA256');
  signer.update(message);
  const signature = base64url(signer.sign(keyPair.privateKeyPem));

  return `${header}.${payload}.${signature}`;
}

/**
 * Mint a JWT that has already expired.
 */
export function mintExpiredJwt(keyPair: TestKeyPair): string {
  const past = Math.floor(Date.now() / 1000) - 3600;
  return mintTestJwt(keyPair, { iat: past - 900, exp: past });
}
