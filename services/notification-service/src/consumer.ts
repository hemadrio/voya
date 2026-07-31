/**
 * Notification consumer — subscribes to domain events and dispatches emails.
 *
 * Retry/DLQ contract:
 *   - Non-retryable failures (PayloadValidationError, UnknownEventTypeError,
 *     SesPermanentRejectionError) → nack(false) → DLQ immediately.
 *   - Retryable failures that exhaust MAX_DELIVERY_ATTEMPTS → nack(false) → DLQ.
 *   - All other transient errors → nack(true) → requeue for retry.
 *
 * Observability: each handler run emits a Pino child logger bound to
 * correlationId, eventId, and eventType so every log line is traceable
 * end-to-end. OTel span is linked to the publisher span via traceparent.
 */

import * as http from 'node:http';
import type { QueuePort, MessageHandler } from '@travel/queue';
import type { QueueMessageEnvelope } from '@travel/contracts';
import type { HealthHandlers } from '@travel/observability';
import {
  PayloadValidationError,
  UnknownEventTypeError,
  SesPermanentRejectionError,
} from './domain/backoff.js';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

interface ConsumerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, string>): ConsumerLogger;
}

// ---------------------------------------------------------------------------
// NotificationDispatcher port — injected by index.ts
// ---------------------------------------------------------------------------

export interface NotificationDispatcher {
  dispatch(envelope: QueueMessageEnvelope, correlationId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Consumer factory options
// ---------------------------------------------------------------------------

export interface NotificationConsumerOptions {
  readonly queue: QueuePort;
  readonly topic: string;
  readonly dispatcher?: NotificationDispatcher | undefined;
  readonly logger: ConsumerLogger;
  readonly healthHandlers?: HealthHandlers | undefined;
  readonly healthPort?: number | undefined;
}

// ---------------------------------------------------------------------------
// Health server
// ---------------------------------------------------------------------------

function startHealthServer(
  handlers: HealthHandlers,
  port: number,
  logger: ConsumerLogger,
): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/health/live') {
      handlers.liveHandler(req, res);
    } else if (url === '/health/ready') {
      handlers.readyHandler(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'unhealthy', error: 'internal' }));
        }
        logger.error({ err }, 'Health ready handler threw');
      });
    } else {
      res.writeHead(404).end();
    }
  });

  server.listen(port, () => {
    logger.info({ port }, 'Health HTTP server listening');
  });

  return server;
}

// ---------------------------------------------------------------------------
// startNotificationConsumer
// ---------------------------------------------------------------------------

/**
 * Start the notification consumer. Returns a cleanup function for graceful
 * shutdown.
 */
export async function startNotificationConsumer(
  options: NotificationConsumerOptions,
): Promise<() => Promise<void>> {
  const { queue, topic, dispatcher, logger, healthHandlers, healthPort = 8081 } = options;

  const handler: MessageHandler = async (envelope, handle, traceContext) => {
    const correlationId = traceContext.correlationId ?? envelope.correlationId;

    const handlerLogger = logger.child({
      correlationId,
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      ...(traceContext.traceparent !== undefined
        ? { traceparent: traceContext.traceparent }
        : {}),
    });

    handlerLogger.info({ userId: envelope.userId }, 'Processing notification event');

    if (dispatcher === undefined) {
      handlerLogger.warn(
        { eventType: envelope.eventType },
        'No dispatcher configured — notification skipped',
      );
      await handle.ack();
      return;
    }

    try {
      await dispatcher.dispatch(envelope, correlationId);
      await handle.ack();
      handlerLogger.info({}, 'Notification event processed successfully');
    } catch (err) {
      if (isNonRetryable(err)) {
        handlerLogger.error(
          {
            event: 'notification.dlq',
            errName: err instanceof Error ? err.name : 'UnknownError',
            err: err instanceof Error ? err.message : String(err),
          },
          'Non-retryable failure — routing to DLQ',
        );
        await handle.nack(false);
      } else {
        handlerLogger.error(
          {
            event: 'notification.requeue',
            errName: err instanceof Error ? err.name : 'UnknownError',
            err: err instanceof Error ? err.message : String(err),
          },
          'Transient failure — nacking for redelivery',
        );
        await handle.nack(true);
      }
    }
  };

  await queue.subscribe(topic, handler);
  logger.info({ topic }, 'Notification consumer started');

  const healthServer =
    healthHandlers !== undefined
      ? startHealthServer(healthHandlers, healthPort, logger)
      : undefined;

  return async () => {
    if (healthServer !== undefined) {
      await new Promise<void>((resolve) => healthServer.close(() => resolve()));
      logger.info({ healthPort }, 'Health HTTP server stopped');
    }
    await queue.close();
    logger.info({ topic }, 'Notification consumer stopped');
  };
}

function isNonRetryable(err: unknown): boolean {
  return (
    err instanceof PayloadValidationError ||
    err instanceof UnknownEventTypeError ||
    err instanceof SesPermanentRejectionError
  );
}
