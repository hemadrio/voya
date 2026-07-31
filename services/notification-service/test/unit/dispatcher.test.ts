/**
 * Unit tests for NotificationDispatcher.
 *
 * All I/O is faked — no SES, no Redis, no Postgres.
 * Tests cover: happy path, duplicate suppression (Redis), duplicate
 * suppression (DB), suppression-list skip, retryable vs non-retryable
 * classification, backoff invocation, and template selection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationDispatcher } from '../../src/domain/NotificationDispatcher.js';
import type { NotificationDispatcherOptions } from '../../src/domain/NotificationDispatcher.js';
import type { IdempotencyGuard, GuardResult } from '../../src/domain/IdempotencyGuard.js';
import type { SuppressionRepository } from '../../src/repositories/SuppressionRepository.js';
import type { EmailPort } from '../../src/adapters/SesEmailAdapter.js';
import {
  SesThrottlingError,
  SesPermanentRejectionError,
  UnknownEventTypeError,
  PayloadValidationError,
  MAX_DELIVERY_ATTEMPTS,
} from '../../src/domain/backoff.js';
import type { QueueMessageEnvelope } from '@travel/contracts';

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeGuard(result: GuardResult = 'new') {
  return { claim: vi.fn().mockResolvedValue(result) } as unknown as IdempotencyGuard;
}

function makeSuppression(suppressed = false) {
  return {
    isSuppressed: vi.fn().mockResolvedValue(suppressed),
    suppress: vi.fn().mockResolvedValue(undefined),
  } as unknown as SuppressionRepository;
}

function makeEmail() {
  return { send: vi.fn().mockResolvedValue(undefined) } as unknown as EmailPort;
}

function makeSleep() {
  return vi.fn().mockResolvedValue(undefined);
}

function makeOptions(overrides: Partial<NotificationDispatcherOptions> = {}): NotificationDispatcherOptions {
  return {
    guard: makeGuard(),
    suppression: makeSuppression(),
    email: makeEmail(),
    logger: makeLogger(),
    sleep: makeSleep(),
    ...overrides,
  };
}

const CONFIRMED_ENVELOPE: QueueMessageEnvelope = {
  eventId: '00000000-0000-4000-8000-000000000001',
  eventType: 'booking.confirmed',
  occurredAt: '2026-01-15T10:00:00.000Z',
  correlationId: 'corr-test-0001',
  schemaVersion: 1,
  userId: '00000000-0000-4000-8000-000000000002',
  payload: {
    correlationId: 'corr-test-0001',
    bookingId: '00000000-0000-4000-8000-000000000003',
    userId: '00000000-0000-4000-8000-000000000002',
    contactEmail: 'synthetic-traveller@example.test',
    occurredAt: '2026-01-15T10:00:00.000Z',
  },
};

const CANCELLED_ENVELOPE: QueueMessageEnvelope = {
  ...CONFIRMED_ENVELOPE,
  eventId: '00000000-0000-4000-8000-000000000011',
  eventType: 'booking.cancelled',
  payload: {
    ...CONFIRMED_ENVELOPE.payload,
    reason: 'Customer request',
  },
};

const MODIFIED_ENVELOPE: QueueMessageEnvelope = {
  ...CONFIRMED_ENVELOPE,
  eventId: '00000000-0000-4000-8000-000000000021',
  eventType: 'booking.modified',
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('NotificationDispatcher — happy path', () => {
  it('calls email.send once for booking.confirmed', async () => {
    const email = makeEmail();
    const dispatcher = new NotificationDispatcher(makeOptions({ email }));

    await dispatcher.dispatch(CONFIRMED_ENVELOPE, 'corr-001');

    expect(email.send).toHaveBeenCalledOnce();
  });

  it('sends to correct template for booking.confirmed', async () => {
    const email = makeEmail();
    const dispatcher = new NotificationDispatcher(makeOptions({ email }));

    await dispatcher.dispatch(CONFIRMED_ENVELOPE, 'corr-001');

    const call = (email.send as ReturnType<typeof vi.fn>).mock.calls[0] as [{ templateName: string }];
    expect(call[0].templateName).toBe('travel-booking-confirmation-v1');
  });

  it('sends to correct template for booking.cancelled', async () => {
    const email = makeEmail();
    const dispatcher = new NotificationDispatcher(makeOptions({ email }));

    await dispatcher.dispatch(CANCELLED_ENVELOPE, 'corr-011');

    const call = (email.send as ReturnType<typeof vi.fn>).mock.calls[0] as [{ templateName: string }];
    expect(call[0].templateName).toBe('travel-booking-cancellation-v1');
  });

  it('sends to correct template for booking.modified', async () => {
    const email = makeEmail();
    const dispatcher = new NotificationDispatcher(makeOptions({ email }));

    await dispatcher.dispatch(MODIFIED_ENVELOPE, 'corr-021');

    const call = (email.send as ReturnType<typeof vi.fn>).mock.calls[0] as [{ templateName: string }];
    expect(call[0].templateName).toBe('travel-booking-modification-v1');
  });

  it('projects template data from validated payload only (no raw spread)', async () => {
    const email = makeEmail();
    const dispatcher = new NotificationDispatcher(makeOptions({ email }));

    await dispatcher.dispatch(CONFIRMED_ENVELOPE, 'corr-001');

    const call = (email.send as ReturnType<typeof vi.fn>).mock.calls[0] as [{ templateData: Record<string, string> }];
    const data = call[0].templateData;
    // Only projected fields present — no raw envelope leakage
    expect(Object.keys(data).sort()).toEqual(['bookingId', 'occurredAt', 'userId'].sort());
  });

  it('claims idempotency slot before sending', async () => {
    const guard = makeGuard('new');
    const email = makeEmail();
    const dispatcher = new NotificationDispatcher(makeOptions({ guard, email }));

    const calls: string[] = [];
    (guard.claim as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push('guard');
      return 'new';
    });
    (email.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push('email');
    });

    await dispatcher.dispatch(CONFIRMED_ENVELOPE, 'corr-001');

    // Guard must be called before email
    expect(calls.indexOf('guard')).toBeLessThan(calls.indexOf('email'));
  });
});

// ---------------------------------------------------------------------------
// Duplicate suppression
// ---------------------------------------------------------------------------

describe('NotificationDispatcher — duplicate suppression', () => {
  it('skips email.send when guard returns duplicate', async () => {
    const email = makeEmail();
    const guard = makeGuard('duplicate');
    const dispatcher = new NotificationDispatcher(makeOptions({ guard, email }));

    await dispatcher.dispatch(CONFIRMED_ENVELOPE, 'corr-001');

    expect(email.send).not.toHaveBeenCalled();
  });

  it('does not throw on duplicate — returns normally', async () => {
    const guard = makeGuard('duplicate');
    const dispatcher = new NotificationDispatcher(makeOptions({ guard }));

    await expect(dispatcher.dispatch(CONFIRMED_ENVELOPE, 'corr-001')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suppression list
// ---------------------------------------------------------------------------

describe('NotificationDispatcher — suppression list', () => {
  it('skips email.send when recipient is suppressed', async () => {
    const email = makeEmail();
    const suppression = makeSuppression(true);
    const dispatcher = new NotificationDispatcher(makeOptions({ email, suppression }));

    await dispatcher.dispatch(CONFIRMED_ENVELOPE, 'corr-001');

    expect(email.send).not.toHaveBeenCalled();
  });

  it('does not call guard when recipient is suppressed', async () => {
    const guard = makeGuard('new');
    const suppression = makeSuppression(true);
    const dispatcher = new NotificationDispatcher(makeOptions({ guard, suppression }));

    await dispatcher.dispatch(CONFIRMED_ENVELOPE, 'corr-001');

    expect(guard.claim).not.toHaveBeenCalled();
  });

  it('logs warn event for suppressed recipient (no PII in log)', async () => {
    const logger = makeLogger();
    const suppression = makeSuppression(true);
    const dispatcher = new NotificationDispatcher(makeOptions({ logger, suppression }));

    await dispatcher.dispatch(CONFIRMED_ENVELOPE, 'corr-001');

    expect(logger.warn).toHaveBeenCalledOnce();
    const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>];
    const logObj = warnCall[0];
    // recipientHash must be present; raw email must NOT be present
    expect(logObj['recipientHash']).toBeDefined();
    expect(JSON.stringify(logObj)).not.toContain('synthetic-traveller');
    expect(JSON.stringify(logObj)).not.toContain('@');
  });
});

// ---------------------------------------------------------------------------
// Non-retryable failures → immediate throw
// ---------------------------------------------------------------------------

describe('NotificationDispatcher — non-retryable failures', () => {
  it('throws UnknownEventTypeError for unrecognised event type', async () => {
    const badEnvelope: QueueMessageEnvelope = {
      ...CONFIRMED_ENVELOPE,
      eventType: 'itinerary.document.requested',
    };
    const dispatcher = new NotificationDispatcher(makeOptions());

    await expect(dispatcher.dispatch(badEnvelope, 'corr-001')).rejects.toBeInstanceOf(
      UnknownEventTypeError,
    );
  });

  it('throws PayloadValidationError for missing required payload fields', async () => {
    const badEnvelope: QueueMessageEnvelope = {
      ...CONFIRMED_ENVELOPE,
      payload: { correlationId: 'corr-001' }, // missing bookingId, userId
    };
    const dispatcher = new NotificationDispatcher(makeOptions());

    await expect(dispatcher.dispatch(badEnvelope, 'corr-001')).rejects.toBeInstanceOf(
      PayloadValidationError,
    );
  });

  it('throws SesPermanentRejectionError immediately without retry', async () => {
    const email = {
      send: vi.fn().mockRejectedValue(new SesPermanentRejectionError('MessageRejected')),
    } as unknown as EmailPort;
    const sleep = makeSleep();
    const dispatcher = new NotificationDispatcher(makeOptions({ email, sleep }));

    await expect(dispatcher.dispatch(CONFIRMED_ENVELOPE, 'corr-001')).rejects.toBeInstanceOf(
      SesPermanentRejectionError,
    );
    // No sleep calls — no backoff for permanent errors
    expect(sleep).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Retryable failures + backoff
// ---------------------------------------------------------------------------

describe('NotificationDispatcher — retry with backoff', () => {
  it('retries SesThrottlingError up to MAX_DELIVERY_ATTEMPTS times then throws', async () => {
    const email = {
      send: vi.fn().mockRejectedValue(new SesThrottlingError('ThrottlingException')),
    } as unknown as EmailPort;
    const sleep = makeSleep();
    const dispatcher = new NotificationDispatcher(makeOptions({ email, sleep }));

    await expect(dispatcher.dispatch(CONFIRMED_ENVELOPE, 'corr-001')).rejects.toBeInstanceOf(
      SesThrottlingError,
    );

    // MAX_DELIVERY_ATTEMPTS=5, first attempt + 4 retries, sleep called 4 times
    expect(email.send).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS - 1);
  });

  it('succeeds on second attempt (transient throttle then ok)', async () => {
    let calls = 0;
    const email = {
      send: vi.fn().mockImplementation(async () => {
        if (calls++ === 0) throw new SesThrottlingError('ThrottlingException');
      }),
    } as unknown as EmailPort;
    const sleep = makeSleep();
    const dispatcher = new NotificationDispatcher(makeOptions({ email, sleep }));

    await expect(dispatcher.dispatch(CONFIRMED_ENVELOPE, 'corr-001')).resolves.toBeUndefined();

    expect(email.send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Template selection
// ---------------------------------------------------------------------------

describe('NotificationDispatcher — template selection', () => {
  it('booking.confirmed → BOOKING_CONFIRMATION template', async () => {
    const email = makeEmail();
    const dispatcher = new NotificationDispatcher(makeOptions({ email }));
    await dispatcher.dispatch(CONFIRMED_ENVELOPE, 'corr');
    const call = (email.send as ReturnType<typeof vi.fn>).mock.calls[0] as [{ templateName: string }];
    expect(call[0].templateName).toContain('confirmation');
  });

  it('booking.cancelled → CANCELLATION template', async () => {
    const email = makeEmail();
    const dispatcher = new NotificationDispatcher(makeOptions({ email }));
    await dispatcher.dispatch(CANCELLED_ENVELOPE, 'corr');
    const call = (email.send as ReturnType<typeof vi.fn>).mock.calls[0] as [{ templateName: string }];
    expect(call[0].templateName).toContain('cancellation');
  });

  it('booking.modified → MODIFICATION template', async () => {
    const email = makeEmail();
    const dispatcher = new NotificationDispatcher(makeOptions({ email }));
    await dispatcher.dispatch(MODIFIED_ENVELOPE, 'corr');
    const call = (email.send as ReturnType<typeof vi.fn>).mock.calls[0] as [{ templateName: string }];
    expect(call[0].templateName).toContain('modification');
  });
});
