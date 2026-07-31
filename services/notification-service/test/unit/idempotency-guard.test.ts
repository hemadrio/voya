/**
 * Unit tests for IdempotencyGuard.
 *
 * All I/O is faked — no real Redis or Postgres.
 */
import { describe, it, expect, vi } from 'vitest';
import { IdempotencyGuard } from '../../src/domain/IdempotencyGuard.js';
import { NotificationProcessedEventRepository } from '../../src/repositories/NotificationProcessedEventRepository.js';

const BASE_OPTS = {
  provider: 'queue',
  eventId: 'evt-001',
  handler: 'booking.confirmed',
  correlationId: 'corr-001',
};

function makeRepo(insertResult: boolean | 'throw-unique' | 'throw-transient') {
  return {
    insert: vi.fn().mockImplementation(async () => {
      if (insertResult === 'throw-unique') {
        const err = new Error('unique violation');
        (err as unknown as Record<string, unknown>)['code'] = 'P2002';
        throw err;
      }
      if (insertResult === 'throw-transient') {
        const err = new Error('connection timeout');
        (err as unknown as Record<string, unknown>)['code'] = 'P1001';
        throw err;
      }
      return insertResult;
    }),
  } as unknown as NotificationProcessedEventRepository;
}

function makeRedis(setNxResult: 'OK' | null | 'throw') {
  return {
    set: vi.fn().mockImplementation(async () => {
      if (setNxResult === 'throw') throw new Error('ECONNREFUSED');
      return setNxResult;
    }),
  };
}

describe('IdempotencyGuard — Redis hit (hot path duplicate)', () => {
  it('returns duplicate when Redis SET NX returns null (key already exists)', async () => {
    const redis = makeRedis(null);
    const repo = makeRepo(true);
    const guard = new IdempotencyGuard(redis, repo);

    const result = await guard.claim(BASE_OPTS);

    expect(result).toBe('duplicate');
    // DB insert must NOT be called — Redis short-circuits
    expect(repo.insert).not.toHaveBeenCalled();
  });
});

describe('IdempotencyGuard — Redis miss → DB insert (new event)', () => {
  it('returns new when Redis SET NX succeeds and DB inserts', async () => {
    const redis = makeRedis('OK');
    const repo = makeRepo(true);
    const guard = new IdempotencyGuard(redis, repo);

    const result = await guard.claim(BASE_OPTS);

    expect(result).toBe('new');
    expect(repo.insert).toHaveBeenCalledOnce();
  });

  it('passes correct fields to repo.insert', async () => {
    const redis = makeRedis('OK');
    const repo = makeRepo(true);
    const guard = new IdempotencyGuard(redis, repo);

    await guard.claim(BASE_OPTS);

    expect(repo.insert).toHaveBeenCalledWith(BASE_OPTS);
  });
});

describe('IdempotencyGuard — Redis miss → DB says duplicate (P2002 via repo)', () => {
  it('returns duplicate when repo.insert returns false', async () => {
    const redis = makeRedis('OK');
    const repo = makeRepo(false);
    const guard = new IdempotencyGuard(redis, repo);

    const result = await guard.claim(BASE_OPTS);

    expect(result).toBe('duplicate');
  });
});

describe('IdempotencyGuard — Redis unavailable, fallthrough to DB', () => {
  it('returns new when Redis throws but DB inserts successfully', async () => {
    const redis = makeRedis('throw');
    const repo = makeRepo(true);
    const guard = new IdempotencyGuard(redis, repo);

    const result = await guard.claim(BASE_OPTS);

    // Redis failed but DB succeeded — must still return new
    expect(result).toBe('new');
    expect(repo.insert).toHaveBeenCalledOnce();
  });

  it('returns duplicate when Redis throws but DB returns false (duplicate)', async () => {
    const redis = makeRedis('throw');
    const repo = makeRepo(false);
    const guard = new IdempotencyGuard(redis, repo);

    const result = await guard.claim(BASE_OPTS);

    expect(result).toBe('duplicate');
  });
});

describe('IdempotencyGuard — null Redis (no cache configured)', () => {
  it('returns new when DB inserts (Redis null = disabled)', async () => {
    const repo = makeRepo(true);
    const guard = new IdempotencyGuard(null, repo);

    const result = await guard.claim(BASE_OPTS);

    expect(result).toBe('new');
    expect(repo.insert).toHaveBeenCalledOnce();
  });

  it('returns duplicate when DB returns false (null Redis)', async () => {
    const repo = makeRepo(false);
    const guard = new IdempotencyGuard(null, repo);

    const result = await guard.claim(BASE_OPTS);

    expect(result).toBe('duplicate');
  });
});

describe('IdempotencyGuard — DB transient error propagates', () => {
  it('throws TransientDbError when repo throws it', async () => {
    const { TransientDbError } = await import('../../src/domain/backoff.js');
    const redis = makeRedis('OK');
    const repoFail = {
      insert: vi.fn().mockRejectedValue(new TransientDbError('P1001')),
    } as unknown as NotificationProcessedEventRepository;
    const guard = new IdempotencyGuard(redis, repoFail);

    await expect(guard.claim(BASE_OPTS)).rejects.toBeInstanceOf(TransientDbError);
  });
});
