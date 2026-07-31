/**
 * Integration tests: end-to-end notification pipeline with faked I/O.
 *
 * These tests compose the real NotificationDispatcher, IdempotencyGuard,
 * SuppressionRepository, and a fake EmailPort to verify the full pipeline
 * without any external infrastructure.
 *
 * Covers:
 *   - Single delivery produces exactly one send + one DB row
 *   - Five identical deliveries produce exactly one send (BR-03)
 *   - Crash-between-commit-and-ack safety (DB row committed before send)
 *   - Suppressed recipient produces zero sends
 *   - Correlation ID is threaded through to the email send call
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationDispatcher } from '../../src/domain/NotificationDispatcher.js';
import { IdempotencyGuard } from '../../src/domain/IdempotencyGuard.js';
import {
  SuppressionRepository,
} from '../../src/repositories/SuppressionRepository.js';
import { NotificationProcessedEventRepository } from '../../src/repositories/NotificationProcessedEventRepository.js';
import type { EmailPort } from '../../src/adapters/SesEmailAdapter.js';
import type { QueueMessageEnvelope } from '@travel/contracts';

// ---------------------------------------------------------------------------
// In-memory DB fakes
// ---------------------------------------------------------------------------

/** In-memory store for processed events (keyed provider:eventId). */
function makeInMemoryRepo() {
  const store = new Map<string, true>();
  return {
    store,
    insert: vi.fn().mockImplementation(
      async (record: { provider: string; eventId: string; handler: string; correlationId: string }) => {
        const key = `${record.provider}:${record.eventId}`;
        if (store.has(key)) return false;
        store.set(key, true);
        return true;
      },
    ),
  };
}

/** In-memory store for email suppressions (keyed email hash). */
function makeInMemorySuppressionDb() {
  const store = new Map<string, { reason: string }>();
  return {
    store,
    emailSuppression: {
      findUnique: vi.fn().mockImplementation(
        async ({ where }: { where: { emailHash: string } }) => {
          const row = store.get(where.emailHash);
          return row !== undefined ? { emailHash: where.emailHash, reason: row.reason } : null;
        },
      ),
      upsert: vi.fn().mockImplementation(
        async ({ where, create }: { where: { emailHash: string }; create: { reason: string } }) => {
          store.set(where.emailHash, { reason: create.reason });
        },
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENVELOPE: QueueMessageEnvelope = {
  eventId: '00000000-0000-4000-8000-000000000001',
  eventType: 'booking.confirmed',
  occurredAt: '2026-01-15T10:00:00.000Z',
  correlationId: 'corr-integ-001',
  schemaVersion: 1,
  userId: '00000000-0000-4000-8000-000000000002',
  payload: {
    correlationId: 'corr-integ-001',
    bookingId: '00000000-0000-4000-8000-000000000003',
    userId: '00000000-0000-4000-8000-000000000002',
    contactEmail: 'synthetic-integ@example.test',
    occurredAt: '2026-01-15T10:00:00.000Z',
  },
};

// ---------------------------------------------------------------------------
// Helper to build the full composed pipeline
// ---------------------------------------------------------------------------

function buildPipeline(opts?: { repoOverride?: ReturnType<typeof makeInMemoryRepo> }) {
  const rawRepo = opts?.repoOverride ?? makeInMemoryRepo();
  const repo = rawRepo as unknown as InstanceType<typeof NotificationProcessedEventRepository>;
  const suppressionDb = makeInMemorySuppressionDb();
  const suppression = new SuppressionRepository(suppressionDb as never);
  const guard = new IdempotencyGuard(null, repo); // null Redis → pure DB path
  const emailSend = vi.fn().mockResolvedValue(undefined);
  const email: EmailPort = { send: emailSend };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const sleep = vi.fn().mockResolvedValue(undefined);

  const dispatcher = new NotificationDispatcher({
    guard,
    suppression,
    email,
    logger,
    sleep,
  });

  return { dispatcher, emailSend, rawRepo, suppressionDb, suppression, logger };
}

// ---------------------------------------------------------------------------
// AC-4: Single delivery → exactly one send, one DB row
// ---------------------------------------------------------------------------

describe('Integration: single delivery', () => {
  it('produces exactly one email.send call', async () => {
    const { dispatcher, emailSend } = buildPipeline();

    await dispatcher.dispatch(ENVELOPE, ENVELOPE.correlationId);

    expect(emailSend).toHaveBeenCalledOnce();
  });

  it('inserts one row into processed_events store', async () => {
    const rawRepo = makeInMemoryRepo();
    const { dispatcher } = buildPipeline({ repoOverride: rawRepo });

    await dispatcher.dispatch(ENVELOPE, ENVELOPE.correlationId);

    expect(rawRepo.store.size).toBe(1);
  });

  it('threads correlationId through to email send', async () => {
    const { dispatcher, emailSend } = buildPipeline();

    await dispatcher.dispatch(ENVELOPE, 'corr-custom-123');

    const call = emailSend.mock.calls[0] as [{ correlationId: string }];
    expect(call[0].correlationId).toBe('corr-custom-123');
  });
});

// ---------------------------------------------------------------------------
// AC-4: Duplicate delivery (five identical events → one send)
// ---------------------------------------------------------------------------

describe('Integration: duplicate suppression (BR-03)', () => {
  it('five identical deliveries produce exactly one email.send call', async () => {
    const rawRepo = makeInMemoryRepo();
    const { dispatcher, emailSend } = buildPipeline({ repoOverride: rawRepo });

    for (let i = 0; i < 5; i++) {
      await dispatcher.dispatch(ENVELOPE, ENVELOPE.correlationId);
    }

    expect(emailSend).toHaveBeenCalledOnce();
  });

  it('five identical deliveries produce exactly one processed_event row', async () => {
    const rawRepo = makeInMemoryRepo();
    const { dispatcher } = buildPipeline({ repoOverride: rawRepo });

    for (let i = 0; i < 5; i++) {
      await dispatcher.dispatch(ENVELOPE, ENVELOPE.correlationId);
    }

    expect(rawRepo.store.size).toBe(1);
  });

  it('second delivery is suppressed without calling email.send', async () => {
    const { dispatcher, emailSend } = buildPipeline();

    await dispatcher.dispatch(ENVELOPE, ENVELOPE.correlationId);
    emailSend.mockClear();
    await dispatcher.dispatch(ENVELOPE, ENVELOPE.correlationId);

    expect(emailSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-5: Crash-between-commit-and-ack safety
// ---------------------------------------------------------------------------

describe('Integration: crash safety — DB committed before send', () => {
  it('does not send a second email when DB row is already committed', async () => {
    // Simulate: first dispatch commits DB row but SES throws (crash)
    const rawRepo = makeInMemoryRepo();
    let throwOnSend = true;
    const emailSend = vi.fn().mockImplementation(async () => {
      if (throwOnSend) {
        throwOnSend = false;
        throw new Error('Simulated crash during SES send');
      }
    });
    const repo = rawRepo as unknown as InstanceType<typeof NotificationProcessedEventRepository>;
    const suppressionDb = makeInMemorySuppressionDb();
    const suppression = new SuppressionRepository(suppressionDb as never);
    const guard = new IdempotencyGuard(null, repo);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sleep = vi.fn().mockResolvedValue(undefined);

    const dispatcher = new NotificationDispatcher({
      guard,
      suppression,
      email: { send: emailSend },
      logger,
      sleep,
    });

    // First delivery: DB row committed, then SES throws
    await expect(
      dispatcher.dispatch(ENVELOPE, ENVELOPE.correlationId),
    ).rejects.toThrow('Simulated crash');

    // DB row IS committed (size=1) even though send threw
    expect(rawRepo.store.size).toBe(1);

    // Second delivery (redelivery after crash): guard finds existing row → duplicate
    await dispatcher.dispatch(ENVELOPE, ENVELOPE.correlationId);

    // Total SES calls: 1 (the failed first attempt) — no second send
    expect(emailSend).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC-7: Suppression list check
// ---------------------------------------------------------------------------

describe('Integration: suppression list', () => {
  it('skips send for suppressed recipient and returns normally', async () => {
    const { dispatcher, emailSend, suppression } = buildPipeline();

    // Suppress the recipient first
    await suppression.suppress('synthetic-integ@example.test', 'BOUNCE', 'evt-bounce');

    await dispatcher.dispatch(ENVELOPE, ENVELOPE.correlationId);

    expect(emailSend).not.toHaveBeenCalled();
  });

  it('sends normally for non-suppressed recipient', async () => {
    const { dispatcher, emailSend } = buildPipeline();

    await dispatcher.dispatch(ENVELOPE, ENVELOPE.correlationId);

    expect(emailSend).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// AC-13: Correlation ID matches publisher's
// ---------------------------------------------------------------------------

describe('Integration: correlation ID continuity', () => {
  it('email send carries the same correlationId as the envelope', async () => {
    const { dispatcher, emailSend } = buildPipeline();
    const publisherCorrId = 'publisher-corr-xyz';
    const envelopeWithCorr = { ...ENVELOPE, correlationId: publisherCorrId };

    await dispatcher.dispatch(envelopeWithCorr, publisherCorrId);

    const call = emailSend.mock.calls[0] as [{ correlationId: string }];
    expect(call[0].correlationId).toBe(publisherCorrId);
  });
});
