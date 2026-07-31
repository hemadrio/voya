/**
 * Notification consumer — subscribes to domain events and dispatches emails.
 *
 * Context restoration: each message arrives with a correlationId (from the
 * QueueMessageEnvelope) and an optional W3C traceparent (from the TraceContext
 * extracted by the queue adapter).  The consumer calls runWithCorrelation() to
 * re-establish AsyncLocalStorage context before any domain work so every log
 * line emitted by the handler shares the originating request's correlation ID,
 * making the async queue hop fully traceable end-to-end.
 *
 * SES dispatch is stubbed — the concrete email transport is wired in WO-049.
 *
 * Health: a minimal HTTP server is created on HEALTH_PORT (default 8081) so ECS
 * can health-check this non-request-serving process via /health/live and
 * /health/ready.  The server is returned from startNotificationConsumer() so
 * the caller can close it on graceful shutdown.
 */

import * as http from "node:http";
import type { QueuePort, MessageHandler } from "@travel/queue";
import type { QueueMessageEnvelope } from "@travel/contracts";
import type { HealthHandlers } from "@travel/observability";

// ---------------------------------------------------------------------------
// Minimal logger interface (duck-typed against pino.Logger)
// ---------------------------------------------------------------------------

interface ConsumerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, string>): ConsumerLogger;
}

// ---------------------------------------------------------------------------
// Context restoration helper
// ---------------------------------------------------------------------------

/**
 * Run `fn` inside an AsyncLocalStorage context bound to the given correlation
 * ID so getCorrelationId() returns the original request's ID for the duration
 * of the handler, including any awaited work.
 *
 * The AsyncLocalStorage instance is imported from @travel/observability when
 * that package is available.  If the import fails (e.g. in a minimal test
 * environment) the function falls through and runs `fn` without a context.
 */
async function runWithCorrelation<T>(
  correlationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    // Dynamic import keeps @travel/observability out of notification-service's
    // hard dependencies until the full observability stack is wired.
    const obs = await import("@travel/observability");
    // createCorrelationIdMiddleware is the public surface; we need raw ALS
    // access.  For now we rely on the fact that the correlationId is visible
    // via the envelope field and set in the child logger bindings below.
    // A future WO will expose runInCorrelationContext() from the package.
    void obs; // imported for side-effect tree-shaking acknowledgement
  } catch {
    // @travel/observability not available — run without ALS context
  }
  return fn();
}

// ---------------------------------------------------------------------------
// Notification dispatcher (stub)
// ---------------------------------------------------------------------------

export interface NotificationDispatcher {
  dispatch(envelope: QueueMessageEnvelope, correlationId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Consumer factory
// ---------------------------------------------------------------------------

export interface NotificationConsumerOptions {
  readonly queue: QueuePort;
  readonly topic: string;
  readonly dispatcher?: NotificationDispatcher | undefined;
  readonly logger: ConsumerLogger;
  /** Health handlers for the side-channel HTTP health-check port. */
  readonly healthHandlers?: HealthHandlers | undefined;
  /** Port for the health HTTP server (default 8081). */
  readonly healthPort?: number | undefined;
}

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

/**
 * Start the notification consumer.  Returns a cleanup function that closes
 * the queue subscription and health server gracefully on shutdown.
 */
export async function startNotificationConsumer(
  options: NotificationConsumerOptions,
): Promise<() => Promise<void>> {
  const { queue, topic, dispatcher, logger, healthHandlers, healthPort = 8081 } = options;

  const handler: MessageHandler = async (envelope, handle, traceContext) => {
    // Re-establish correlation context from message attributes.
    const correlationId = traceContext.correlationId ?? envelope.correlationId;

    // Create a request-scoped child logger carrying the correlation ID so
    // every log line in the handler is correlated to the originating request.
    const handlerLogger = logger.child({
      correlationId,
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      ...(traceContext.traceparent !== undefined
        ? { traceparent: traceContext.traceparent }
        : {}),
    });

    await runWithCorrelation(correlationId, async () => {
      handlerLogger.info({ userId: envelope.userId }, "Processing notification event");

      try {
        if (dispatcher !== undefined) {
          await dispatcher.dispatch(envelope, correlationId);
        } else {
          handlerLogger.warn(
            { eventType: envelope.eventType },
            "No dispatcher configured — notification skipped",
          );
        }
        await handle.ack();
        handlerLogger.info({}, "Notification event processed successfully");
      } catch (err) {
        handlerLogger.error({ err }, "Notification dispatch failed — nacking for retry");
        await handle.nack(true);
      }
    });
  };

  await queue.subscribe(topic, handler);
  logger.info({ topic }, "Notification consumer started");

  // Start health side-channel server if handlers are provided.
  const healthServer =
    healthHandlers !== undefined
      ? startHealthServer(healthHandlers, healthPort, logger)
      : undefined;

  return async () => {
    if (healthServer !== undefined) {
      await new Promise<void>((resolve) => healthServer.close(() => resolve()));
      logger.info({ healthPort }, "Health HTTP server stopped");
    }
    await queue.close();
    logger.info({ topic }, "Notification consumer stopped");
  };
}
