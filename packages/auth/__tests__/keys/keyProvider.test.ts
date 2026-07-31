import { KeyProvider } from '../../src/keys/keyProvider.js';
import type { KeyStore, KeyPair, KeyMaterial } from '../../src/keys/keyProvider.js';
import { KEY_PAIR_V1, KEY_PAIR_V2 } from '../fixtures/testKeyPairs.js';

// ── Mock KeyStore factory ────────────────────────────────────────────────────

function makeStore(
  current: KeyPair,
  previous: Pick<KeyMaterial, 'publicKeyPem' | 'activatedAt' | 'version'> | null,
): KeyStore {
  return {
    getCurrentKey: jest.fn().mockResolvedValue(current),
    getPreviousKey: jest.fn().mockResolvedValue(previous),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('KeyProvider.getSigningKey', () => {
  it('returns the current key private PEM', async () => {
    const store = makeStore(KEY_PAIR_V2, null);
    const provider = new KeyProvider({ store });

    const key = await provider.getSigningKey();

    expect(key.privateKeyPem).toBe(KEY_PAIR_V2.privateKeyPem);
    expect(key.version).toBe('v2');
  });

  it('calls the store exactly once when cache is warm', async () => {
    const store = makeStore(KEY_PAIR_V2, null);
    const provider = new KeyProvider({ store, cacheTtlMs: 60_000 });

    await provider.getSigningKey();
    await provider.getSigningKey();

    expect(store.getCurrentKey).toHaveBeenCalledTimes(1);
  });

  it('calls the store again after cache TTL expires', async () => {
    let nowMs = 0;
    const store = makeStore(KEY_PAIR_V2, null);
    const provider = new KeyProvider({
      store,
      cacheTtlMs: 1_000,
      now: () => nowMs,
    });

    await provider.getSigningKey();
    nowMs = 1_001; // advance past TTL
    await provider.getSigningKey();

    expect(store.getCurrentKey).toHaveBeenCalledTimes(2);
  });

  it('calls the store again after invalidateCache()', async () => {
    const store = makeStore(KEY_PAIR_V2, null);
    const provider = new KeyProvider({ store, cacheTtlMs: 60_000 });

    await provider.getSigningKey();
    provider.invalidateCache();
    await provider.getSigningKey();

    expect(store.getCurrentKey).toHaveBeenCalledTimes(2);
  });
});

describe('KeyProvider.getVerificationKeys', () => {
  it('returns only the current key when no previous key exists', async () => {
    const store = makeStore(KEY_PAIR_V2, null);
    const provider = new KeyProvider({ store });

    const keys = await provider.getVerificationKeys();

    expect(keys).toHaveLength(1);
    expect(keys[0]?.version).toBe('v2');
  });

  it('returns current + previous during the overlap window', async () => {
    // Previous key was activated 12 h ago — within the 24 h default overlap
    const twelveHoursAgo = new Date(Date.now() - 12 * HOUR_MS).toISOString();
    const previous = {
      publicKeyPem: KEY_PAIR_V1.publicKeyPem,
      activatedAt: twelveHoursAgo,
      version: 'v1',
    };
    const store = makeStore(KEY_PAIR_V2, previous);
    const provider = new KeyProvider({ store });

    const keys = await provider.getVerificationKeys();

    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.version)).toEqual(['v2', 'v1']);
  });

  it('excludes previous key after overlap window expires', async () => {
    // Previous key was activated 25 h ago — outside the 24 h overlap
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * HOUR_MS).toISOString();
    const previous = {
      publicKeyPem: KEY_PAIR_V1.publicKeyPem,
      activatedAt: twentyFiveHoursAgo,
      version: 'v1',
    };
    const store = makeStore(KEY_PAIR_V2, previous);
    const provider = new KeyProvider({ store });

    const keys = await provider.getVerificationKeys();

    expect(keys).toHaveLength(1);
    expect(keys[0]?.version).toBe('v2');
  });

  it('respects a custom overlapMs value', async () => {
    // Key activated 2 h ago; using a 1 h overlap — should be excluded
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR_MS).toISOString();
    const previous = {
      publicKeyPem: KEY_PAIR_V1.publicKeyPem,
      activatedAt: twoHoursAgo,
      version: 'v1',
    };
    const store = makeStore(KEY_PAIR_V2, previous);
    const provider = new KeyProvider({ store, overlapMs: HOUR_MS });

    const keys = await provider.getVerificationKeys();

    expect(keys).toHaveLength(1);
    expect(keys[0]?.version).toBe('v2');
  });

  it('includes previous key within a custom short overlap window', async () => {
    // Key activated 30 min ago; 1 h overlap — should still be included
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    const previous = {
      publicKeyPem: KEY_PAIR_V1.publicKeyPem,
      activatedAt: thirtyMinAgo,
      version: 'v1',
    };
    const store = makeStore(KEY_PAIR_V2, previous);
    const provider = new KeyProvider({ store, overlapMs: HOUR_MS });

    const keys = await provider.getVerificationKeys();

    expect(keys).toHaveLength(2);
  });
});

describe('KeyProvider — rotation boundary behaviour', () => {
  it('uses controllable clock to test overlap exactly at boundary', async () => {
    let nowMs = DAY_MS * 100; // arbitrary base time

    // Previous key activated exactly at the overlap boundary
    const activatedAt = new Date(nowMs - DAY_MS).toISOString();
    const previous = {
      publicKeyPem: KEY_PAIR_V1.publicKeyPem,
      activatedAt,
      version: 'v1',
    };
    const store = makeStore(KEY_PAIR_V2, previous);
    const provider = new KeyProvider({ store, overlapMs: DAY_MS, now: () => nowMs });

    // Exactly at boundary — overlapMs elapsed — should NOT be included
    let keys = await provider.getVerificationKeys();
    expect(keys).toHaveLength(1);

    // 1 ms before boundary — should be included
    nowMs = DAY_MS * 100 - 1;
    provider.invalidateCache();
    keys = await provider.getVerificationKeys();
    expect(keys).toHaveLength(2);
  });
});
