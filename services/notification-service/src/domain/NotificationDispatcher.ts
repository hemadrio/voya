/**
 * NotificationDispatcher — domain service that orchestrates email delivery.
 *
 * Order of operations (crash-safe):
 *   1. Parse and validate envelope payload with Zod.
 *   2. Check suppression list — skip and ack if suppressed.
 *   3. Claim idempotency slot (Redis SET NX + DB insert).
 *   4. If duplicate → ack immediately, no send.
 *   5. Dispatch SES send.
 *   6. Return (caller acks queue message).
 *
 * The DB insert (step 3) is committed BEFORE the SES send (step 5).
 * If the process crashes between insert and send, the event redelivers and
 * step 3 returns 'duplicate', so no second email is sent.  SES deduplication
 * keys are not relied upon as the primary guard — only as a belt-and-suspenders.
 *
 * This class imports no Express, Prisma, or queue types directly — all I/O
 * flows through injected ports so unit tests run with zero external deps.
 *
 * Payload validation note: BookingConfirmationEventSchema in @travel/contracts
 * is .strict(). The dispatcher uses .strip() (passthrough stripping unknown
 * keys) so that the booking service can include contactEmail in the payload
 * alongside the domain-fact fields without causing a validation failure. Only
 * the fields listed in the schema are validated; extra fields are ignored and
 * NOT spread into template data.
 */

import { z } from 'zod';
import type { QueueMessageEnvelope } from '@travel/contracts';
import {
  PayloadValidationError,
  UnknownEventTypeError,
  isRetryable,
  MAX_DELIVERY_ATTEMPTS,
  computeBackoffMs,
  type BackoffConfig,
} from './backoff.js';
import type { IdempotencyGuard } from './IdempotencyGuard.js';
import type { SuppressionRepository } from '../repositories/SuppressionRepository.js';
import { hashEmail } from '../repositories/SuppressionRepository.js';
import type { EmailPort } from '../adapters/SesEmailAdapter.js';
import { TEMPLATE_NAMES } from '../adapters/SesEmailAdapter.js';
import type { TemplateName } from '../adapters/SesEmailAdapter.js';

// ---------------------------------------------------------------------------
// Logger interface (duck-typed against pino.Logger.child)
// ---------------------------------------------------------------------------

interface DispatchLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Local payload validation schemas
//
// These are intentionally non-strict (.strip()) so the booking service can
// include contactEmail (needed by this consumer) alongside domain-fact fields
// without breaking the contracts package's strict schema.
// Template data is always projected explicitly from known fields only.
// ---------------------------------------------------------------------------

const BookingPayloadSchema = z
  .object({
    correlationId: z.string().min(1),
    bookingId: z.string().uuid(),
    userId: z.string().uuid(),
    occurredAt: z.string().datetime({ offset: true }),
    // contactEmail is the notification recipient — included by the booking
    // service in the event payload for this consumer to use.
    contactEmail: z.string().email().optional(),
  })
  .strip();

const CancellationPayloadSchema = BookingPayloadSchema.extend({
  reason: z.string().optional(),
}).strip();

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

interface TemplateMapping {
  readonly templateName: TemplateName;
  readonly projectData: (payload: Record<string, unknown>) => Record<string, string>;
}

const EVENT_TEMPLATE_MAP: Readonly<Record<string, TemplateMapping>> = {
  'booking.confirmed': {
    templateName: TEMPLATE_NAMES.BOOKING_CONFIRMATION,
    projectData: (payload) => ({
      bookingId: String(payload['bookingId'] ?? ''),
      userId: String(payload['userId'] ?? ''),
      occurredAt: String(payload['occurredAt'] ?? ''),
    }),
  },
  'booking.cancelled': {
    templateName: TEMPLATE_NAMES.CANCELLATION,
    projectData: (payload) => ({
      bookingId: String(payload['bookingId'] ?? ''),
      userId: String(payload['userId'] ?? ''),
      reason: String(payload['reason'] ?? ''),
      occurredAt: String(payload['occurredAt'] ?? ''),
    }),
  },
  'booking.modified': {
    templateName: TEMPLATE_NAMES.MODIFICATION,
    projectData: (payload) => ({
      bookingId: String(payload['bookingId'] ?? ''),
      userId: String(payload['userId'] ?? ''),
      occurredAt: String(payload['occurredAt'] ?? ''),
    }),
  },
};

// ---------------------------------------------------------------------------
// Payload validators by event type
// ---------------------------------------------------------------------------

function validatePayload(
  eventType: string,
  payload: Record<string, unknown>,
): { validatedPayload: Record<string, unknown>; recipientEmail: string | null } {
  switch (eventType) {
    case 'booking.confirmed':
    case 'booking.modified': {
      const result = BookingPayloadSchema.safeParse(payload);
      if (!result.success) {
        throw new PayloadValidationError(
          `${eventType} payload invalid: ${result.error.message}`,
        );
      }
      return {
        validatedPayload: result.data,
        recipientEmail: result.data.contactEmail ?? null,
      };
    }
    case 'booking.cancelled': {
      const result = CancellationPayloadSchema.safeParse(payload);
      if (!result.success) {
        throw new PayloadValidationError(
          `booking.cancelled payload invalid: ${result.error.message}`,
        );
      }
      return {
        validatedPayload: result.data,
        recipientEmail: result.data.contactEmail ?? null,
      };
    }
    default:
      throw new UnknownEventTypeError(`Unhandled event type: ${eventType}`);
  }
}

// ---------------------------------------------------------------------------
// NotificationDispatcher
// ---------------------------------------------------------------------------

export interface NotificationDispatcherOptions {
  readonly guard: IdempotencyGuard;
  readonly suppression: SuppressionRepository;
  readonly email: EmailPort;
  readonly logger: DispatchLogger;
  readonly backoffConfig?: BackoffConfig | undefined;
  /** Injected sleep for test-controlled backoff delays. Default: real setTimeout. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export class NotificationDispatcher {
  private readonly guard: IdempotencyGuard;
  private readonly suppression: SuppressionRepository;
  private readonly email: EmailPort;
  private readonly logger: DispatchLogger;
  private readonly backoffConfig: BackoffConfig | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: NotificationDispatcherOptions) {
    this.guard = opts.guard;
    this.suppression = opts.suppression;
    this.email = opts.email;
    this.logger = opts.logger;
    this.backoffConfig = opts.backoffConfig;
    this.sleep =
      opts.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Dispatch a notification for the given envelope.
   *
   * Throws on non-retryable errors (PayloadValidationError, UnknownEventTypeError,
   * SesPermanentRejectionError) — the caller should nack(false) → DLQ.
   * Throws on retryable errors (SesThrottlingError, TransientDbError, etc.)
   * after exhausting MAX_DELIVERY_ATTEMPTS — the caller should nack(false) → DLQ.
   * Returns normally on success or on duplicate/suppression.
   */
  async dispatch(
    envelope: QueueMessageEnvelope,
    correlationId: string,
  ): Promise<void> {
    const log = this.logger;
    const { eventId, eventType, userId, payload } = envelope;

    // Step 1: map event type to template (throws UnknownEventTypeError for unknown types)
    const mapping = EVENT_TEMPLATE_MAP[eventType];
    if (mapping === undefined) {
      throw new UnknownEventTypeError(`No template mapping for event type: ${eventType}`);
    }

    // Step 2: validate payload and extract recipient
    const { validatedPayload, recipientEmail } = validatePayload(eventType, payload);

    if (recipientEmail === null) {
      throw new PayloadValidationError(
        `Could not extract recipient email from ${eventType} payload — contactEmail is required`,
      );
    }

    const recipientHash = hashEmail(recipientEmail);

    // Step 3: suppression check — short-circuit with no send if suppressed
    const suppressed = await this.suppression.isSuppressed(recipientEmail);
    if (suppressed) {
      log.warn(
        {
          event: 'notification.suppressed',
          eventId,
          eventType,
          correlationId,
          recipientHash,
        },
        'Recipient is suppressed — skipping SES send',
      );
      return;
    }

    // Step 4: idempotency guard — DB insert committed BEFORE SES send
    // This is the crash-safety invariant: if the process dies between insert
    // and send, the next redelivery will find the DB row and return 'duplicate'.
    const guardResult = await this.guard.claim({
      provider: 'queue',
      eventId,
      handler: eventType,
      correlationId,
    });

    if (guardResult === 'duplicate') {
      log.info(
        {
          event: 'notification.duplicate_suppressed',
          eventId,
          eventType,
          correlationId,
          recipientHash,
        },
        'Duplicate event — idempotency guard suppressed send',
      );
      return;
    }

    // Step 5: SES send with retry (capped exponential backoff + jitter)
    const templateData = mapping.projectData(validatedPayload);
    let attempt = 0;

    while (true) {
      try {
        await this.email.send({
          toAddress: recipientEmail,
          templateName: mapping.templateName,
          templateData,
          correlationId,
          deduplicationId: `${eventId}-${attempt}`,
        });

        log.info(
          {
            event: 'notification.sent',
            eventId,
            eventType,
            correlationId,
            recipientHash,
            userId,
            attempt,
          },
          'Notification sent successfully',
        );
        return;
      } catch (err) {
        attempt += 1;

        if (!isRetryable(err) || attempt >= MAX_DELIVERY_ATTEMPTS) {
          log.error(
            {
              event: 'notification.send_failed',
              eventId,
              eventType,
              correlationId,
              recipientHash,
              attempt,
              retryable: isRetryable(err),
              errName: err instanceof Error ? err.name : 'UnknownError',
            },
            'Notification send failed permanently',
          );
          throw err;
        }

        const delayMs = computeBackoffMs(attempt, this.backoffConfig);
        log.warn(
          {
            event: 'notification.send_retrying',
            eventId,
            eventType,
            correlationId,
            recipientHash,
            attempt,
            delayMs,
          },
          'Notification send failed — retrying with backoff',
        );
        await this.sleep(delayMs);
      }
    }
  }
}
