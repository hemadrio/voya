/**
 * SecretsManagerKeyStore — production KeyStore implementation.
 *
 * Fetches JWT key material from AWS Secrets Manager. The secret value is a
 * JSON object with shape:
 *
 *   {
 *     "privateKeyPem": "-----BEGIN PRIVATE KEY-----\n...",
 *     "publicKeyPem":  "-----BEGIN PUBLIC KEY-----\n...",
 *     "activatedAt":   "2025-01-01T00:00:00.000Z",
 *     "version":       "v2"
 *   }
 *
 * GetSecretValue is called with VersionStage:
 *   - AWSCURRENT  → current signing key (includes private key)
 *   - AWSPREVIOUS → previous key (public key only enforced at the caller)
 *
 * This file imports aws-sdk v3 client types. The actual @aws-sdk/client-secrets-manager
 * package is a peer dependency installed only in services that wire this store;
 * the KeyProvider tests use a mock KeyStore and never load this file.
 */

import type { KeyPair, KeyMaterial, KeyStore } from './keyProvider.js';

export type GetSecretFn = (secretId: string, versionStage?: string) => Promise<string>;

function parseKeyMaterial(raw: string, secretId: string): KeyPair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Secret ${secretId} is not valid JSON`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)['privateKeyPem'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['publicKeyPem'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['activatedAt'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['version'] !== 'string'
  ) {
    throw new Error(`Secret ${secretId} is missing required key material fields`);
  }

  const obj = parsed as Record<string, string>;
  return {
    privateKeyPem: obj['privateKeyPem']!,
    publicKeyPem: obj['publicKeyPem']!,
    activatedAt: obj['activatedAt']!,
    version: obj['version']!,
  };
}

function parsePreviousKeyMaterial(
  raw: string,
  secretId: string,
): Pick<KeyMaterial, 'publicKeyPem' | 'activatedAt' | 'version'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Secret ${secretId} (previous) is not valid JSON`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)['publicKeyPem'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['activatedAt'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['version'] !== 'string'
  ) {
    throw new Error(`Secret ${secretId} (previous) is missing required fields`);
  }

  const obj = parsed as Record<string, string>;
  return {
    publicKeyPem: obj['publicKeyPem']!,
    activatedAt: obj['activatedAt']!,
    version: obj['version']!,
  };
}

export class SecretsManagerKeyStore implements KeyStore {
  private readonly secretId: string;
  private readonly getSecret: GetSecretFn;

  constructor(secretId: string, getSecret: GetSecretFn) {
    this.secretId = secretId;
    this.getSecret = getSecret;
  }

  async getCurrentKey(): Promise<KeyPair> {
    const raw = await this.getSecret(this.secretId, 'AWSCURRENT');
    return parseKeyMaterial(raw, this.secretId);
  }

  async getPreviousKey(): Promise<Pick<KeyMaterial, 'publicKeyPem' | 'activatedAt' | 'version'> | null> {
    try {
      const raw = await this.getSecret(this.secretId, 'AWSPREVIOUS');
      return parsePreviousKeyMaterial(raw, this.secretId);
    } catch (err) {
      // AWSPREVIOUS does not exist before the first rotation. Treat as null.
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('ResourceNotFoundException') ||
        message.includes('InvalidRequestException') ||
        message.includes('AWSPREVIOUS')
      ) {
        return null;
      }
      throw err;
    }
  }
}
