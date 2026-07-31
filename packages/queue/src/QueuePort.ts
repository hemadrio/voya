/**
 * QueuePort — the hexagonal-architecture port for async domain event publishing
 * and consuming.
 *
 * Both RabbitMqAdapter and SqsAdapter implement this interface so the calling
 * services (booking, payment, notification, ai) are fully decoupled from the
 * underlying broker. Adapter selection is controlled by QUEUE_DRIVER at
 * startup; no application code is changed when switching from local RabbitMQ
 * to production SQS.
 *
 * Acknowledgement contract:
 *   Consumers MUST call ack() or nack() exactly once per message. Calling
 *   neither will cause the message to redeliver after the visibility timeout
 *   (SQS) or the prefetch window to fill up (RabbitMQ). Calling both is an
 *   error and the second call is a no-op.
 *
 * Non-retryable errors (Zod parse failure, schema version mismatch):
 *   The consumer should call nack(false) — no requeue — and let the broker
 *   route the message to the DLQ via the redrive policy.
 *
 * The interface is generic over the adapter-specific raw message type T so
 * the contract test suite can assert on adapter internals without casting.
 */

import type { QueueMessageEnvelope } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Acknowledgement handle
// ---------------------------------------------------------------------------

/**
 * Passed to every message handler. The consumer calls ack() after committing
 * its database transaction, or nack() to signal failure.
 */
export interface AckHandle {
  /**
   * Acknowledge the message — removes it from the queue (SQS DeleteMessage,
   * RabbitMQ basic.ack).
   */
  ack(): Promise<void>;

  /**
   * Negative-acknowledge the message.
   *
   * @param requeue - When false (default for malformed messages) the message
   *   is immediately routed to the DLQ without incrementing the delivery
   *   count. When true (default for transient failures) it is requeued and
   *   the delivery count increments toward the maxReceiveCount.
   */
  nack(requeue?: boolean): Promise<void>;
}

// ---------------------------------------------------------------------------
// Handler and subscribe options
// ---------------------------------------------------------------------------

/**
 * Async message handler invoked by the adapter for each received message.
 * The handler MUST call handle.ack() or handle.nack() before returning.
 */
export type MessageHandler = (
  envelope: QueueMessageEnvelope,
  handle: AckHandle,
) => Promise<void>;

export interface SubscribeOptions {
  /** RabbitMQ only — basic.qos prefetch count. Default: 10. */
  prefetch?: number | undefined;
  /**
   * SQS only — initial visibility timeout in seconds while the handler runs.
   * Default: 30. The adapter extends it via ChangeMessageVisibility if the
   * handler takes longer.
   */
  visibilityTimeoutSeconds?: number | undefined;
  /**
   * SQS only — WaitTimeSeconds for long polling. Default: 20.
   */
  waitTimeSeconds?: number | undefined;
}

// ---------------------------------------------------------------------------
// QueuePort interface
// ---------------------------------------------------------------------------

/**
 * The surface that all queue adapters must implement.
 *
 * Constraints:
 *  - No adapter-specific types in parameters or return values.
 *  - publish() must validate the envelope against QueueMessageEnvelopeSchema
 *    and throw QueueValidationError before any I/O if validation fails.
 *  - close() must be idempotent.
 */
export interface QueuePort {
  /**
   * Publish an envelope to the given topic/routing-key.
   * Validates the envelope before any I/O; throws QueueValidationError if
   * the envelope fails Zod parse.
   *
   * @param topic - RabbitMQ routing key / SQS queue URL basename.
   * @param envelope - Fully-formed QueueMessageEnvelope.
   */
  publish(topic: string, envelope: QueueMessageEnvelope): Promise<void>;

  /**
   * Subscribe to a topic and invoke the handler for each received message.
   * The adapter runs the polling/consume loop in the background; this method
   * resolves once the subscription is established.
   *
   * @param topic - RabbitMQ queue name / SQS queue URL basename.
   * @param handler - Async handler; must call ack() or nack().
   * @param options - Adapter-specific tuning.
   */
  subscribe(
    topic: string,
    handler: MessageHandler,
    options?: SubscribeOptions,
  ): Promise<void>;

  /**
   * Health probe — resolves to true when the adapter can reach the broker.
   * Used by the deep readiness check; a failed probe should fail the ECS
   * health check before traffic is routed to the container.
   */
  isHealthy(): Promise<boolean>;

  /**
   * Gracefully close the connection and stop all consumers.
   * Idempotent — safe to call more than once.
   */
  close(): Promise<void>;
}
