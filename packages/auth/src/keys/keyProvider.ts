/**
 * KeyProvider — JWT signing key management with two-phase rotation support.
 *
 * Rotation model:
 *   Phase 1: new key material published as current; previous key retained in
 *            the verification set for OVERLAP_MS (24 h by default).
 *   Phase 2: after OVERLAP_MS elapses the previous key is dropped.
 *
 * This means tokens issued up to one rotation event ago remain verifiable for
 * their full 15-minute lifetime plus the overlap window, with no service
 * restart required.
 *
 * The backing store is dependency-injected so tests supply an in-memory mock;
 * production wires the SecretsManagerKeyStore implementation.
 */

export interface KeyMaterial {
  /** PEM-encoded RSA private key (PKCS#8). Only present on the current key. */
  privateKeyPem?: string;
  /** PEM-encoded RSA public key (SPKI). Always present. */
  publicKeyPem: string;
  /** ISO-8601 timestamp when this key became current. */
  activatedAt: string;
  /** Opaque version identifier (e.g. UUID, version stage name). */
  version: string;
}

export interface KeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  activatedAt: string;
  version: string;
}

/**
 * Backing store interface. Implemented by SecretsManagerKeyStore in production
 * and by an in-memory stub in tests.
 */
export interface KeyStore {
  /**
   * Fetch the current active key pair. Throws if the secret is absent or
   * cannot be decoded.
   */
  getCurrentKey(): Promise<KeyPair>;

  /**
   * Fetch the previous key material (public key only). Returns null when no
   * previous key exists (first rotation hasn't occurred yet).
   */
  getPreviousKey(): Promise<Pick<KeyMaterial, 'publicKeyPem' | 'activatedAt' | 'version'> | null>;
}

export interface KeyProviderOptions {
  store: KeyStore;
  /**
   * TTL in milliseconds for the in-memory cache.
   * Default: 60_000 (60 seconds).
   */
  cacheTtlMs?: number;
  /**
   * How long the previous key stays in the verification set after rotation, in
   * milliseconds. Must be at least as long as the access token TTL.
   * Default: 86_400_000 (24 hours).
   */
  overlapMs?: number;
  /** Injected clock function — defaults to Date.now. Override in tests. */
  now?: () => number;
}

interface CachedKeys {
  current: KeyPair;
  previous: Pick<KeyMaterial, 'publicKeyPem' | 'activatedAt' | 'version'> | null;
  fetchedAt: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_OVERLAP_MS = 86_400_000; // 24 hours

export class KeyProvider {
  private readonly store: KeyStore;
  private readonly cacheTtlMs: number;
  private readonly overlapMs: number;
  private readonly now: () => number;
  private cache: CachedKeys | null = null;

  constructor(options: KeyProviderOptions) {
    this.store = options.store;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.overlapMs = options.overlapMs ?? DEFAULT_OVERLAP_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Return the current signing key. Used by token issuers (auth-service).
   * Throws if the backing store is unavailable — callers must not fall back to
   * a default; they should propagate the error to trigger ECS circuit breaker.
   */
  async getSigningKey(): Promise<KeyPair> {
    const keys = await this.getKeys();
    return keys.current;
  }

  /**
   * Return the set of public keys that should be accepted for verification.
   * Includes the current key and the previous key if it is still within the
   * overlap window.
   *
   * Called by token verifiers (api-gateway, all services that validate JWTs).
   */
  async getVerificationKeys(): Promise<Array<Pick<KeyMaterial, 'publicKeyPem' | 'version'>>> {
    const keys = await this.getKeys();
    const result: Array<Pick<KeyMaterial, 'publicKeyPem' | 'version'>> = [
      { publicKeyPem: keys.current.publicKeyPem, version: keys.current.version },
    ];

    if (keys.previous !== null && this.isWithinOverlap(keys.previous.activatedAt)) {
      result.push({
        publicKeyPem: keys.previous.publicKeyPem,
        version: keys.previous.version,
      });
    }

    return result;
  }

  /** Force the next call to hit the backing store. Useful after a rotation event. */
  invalidateCache(): void {
    this.cache = null;
  }

  private async getKeys(): Promise<CachedKeys> {
    const nowMs = this.now();

    if (this.cache !== null && nowMs - this.cache.fetchedAt < this.cacheTtlMs) {
      return this.cache;
    }

    const [current, previous] = await Promise.all([
      this.store.getCurrentKey(),
      this.store.getPreviousKey(),
    ]);

    this.cache = { current, previous, fetchedAt: nowMs };
    return this.cache;
  }

  /**
   * True when the previous key's activation time is recent enough that
   * tokens signed with it may still be in circulation (within overlapMs of
   * when it became the current key, i.e. when the new current was activated).
   *
   * The previous key's activatedAt is the moment it was promoted to current,
   * so the overlap window starts from that point.
   */
  private isWithinOverlap(previousActivatedAt: string): boolean {
    const activatedMs = new Date(previousActivatedAt).getTime();
    return this.now() - activatedMs < this.overlapMs;
  }
}
