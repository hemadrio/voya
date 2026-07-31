/**
 * RabbitMqAdapter — QueuePort implementation for RabbitMQ 3.13.
 *
 * Uses a single amqplib connection (injected) with a durable topic exchange,
 * publisher confirms, prefetch 10, and manual acknowledgement. Reconnect with
 * exponential backoff is handled by the caller (the factory or a supervisor)
 * which re-constructs the adapter with a fresh connection; the adapter itself
 * does not hold reconnect state.
 *
 * Retry policy (on nack with requeue=true):
 *   - Messages are requeued to the original queue and re-delivered up to
 *     maxDeliveryCount times (configurable, default 5).
 *   - After maxDeliveryCount nacks the adapter publishes the message directly
 *     to the DLQ exchange (x-dead-letter-exchange header) without requeueing.
 *
 * The amqplib Connection and Channel types are typed via @types/amqplib.
 * The connection is injected so unit tests can supply a fake.
 */

import type { QueueMessageEnvelope } from "@travel/contracts";
import { QueueMessageEnvelopeSchema } from "@travel/contracts";
import type { QueuePort, MessageHandler, SubscribeOptions, AckHandle } from "../QueuePort.js";
import { QueueValidationError } from "../QueueValidationError.js";
/** Minimal logger surface — duck-typed so callers can inject pino, a test spy, or undefined. */
interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): MinimalLogger;
}

// ---------------------------------------------------------------------------
// Minimal amqplib surface types (avoids a full import that breaks under Jest CJS)
// ---------------------------------------------------------------------------

export interface AmqpChannel {
  assertExchange(exchange: string, type: string, options: object): Promise<unknown>;
  assertQueue(queue: string, options: object): Promise<{ queue: string }>;
  bindQueue(queue: string, exchange: string, routingKey: string): Promise<unknown>;
  prefetch(count: number): void;
  publish(exchange: string, routingKey: string, content: Buffer, options?: object): boolean;
  waitForConfirms(): Promise<void>;
  consume(
    queue: string,
    onMessage: (msg: AmqpMessage | null) => void,
    options?: object,
  ): Promise<unknown>;
  ack(message: AmqpMessage, allUpTo?: boolean): void;
  nack(message: AmqpMessage, allUpTo?: boolean, requeue?: boolean): void;
  close(): Promise<void>;
}

export interface AmqpMessage {
  content: Buffer;
  fields: { deliveryTag: number; redelivered: boolean; routingKey: string };
  properties: {
    headers?: Record<string, unknown> | undefined;
    messageId?: string | undefined;
    correlationId?: string | undefined;
  };
}

export interface AmqpConnection {
  createConfirmChannel(): Promise<AmqpChannel>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface RabbitMqAdapterOptions {
  /** Injected amqplib connection. Tests supply a fake here. */
  connection: AmqpConnection;
  /** Exchange name (topic). Default: 'travel.events'. */
  exchangeName?: string | undefined;
  /** DLQ exchange name. Default: 'travel.events.dlq'. */
  dlqExchangeName?: string | undefined;
  /** Max delivery attempts before routing to DLQ. Default: 5. */
  maxDeliveryCount?: number | undefined;
  /** Optional logger. */
  logger?: MinimalLogger | undefined;
}

// ---------------------------------------------------------------------------
// RabbitMqAdapter
// ---------------------------------------------------------------------------

export class RabbitMqAdapter implements QueuePort {
  private readonly connection: AmqpConnection;
  private readonly exchangeName: string;
  private readonly dlqExchangeName: string;
  private readonly maxDeliveryCount: number;
  private readonly logger: MinimalLogger | undefined;
  private channel: AmqpChannel | undefined;
  private closed = false;

  constructor(options: RabbitMqAdapterOptions) {
    this.connection = options.connection;
    this.exchangeName = options.exchangeName ?? "travel.events";
    this.dlqExchangeName = options.dlqExchangeName ?? "travel.events.dlq";
    this.maxDeliveryCount = options.maxDeliveryCount ?? 5;
    this.logger = options.logger;
  }

  private async getChannel(): Promise<AmqpChannel> {
    if (this.channel !== undefined) return this.channel;
    const ch = await this.connection.createConfirmChannel();
    await ch.assertExchange(this.exchangeName, "topic", { durable: true });
    await ch.assertExchange(this.dlqExchangeName, "topic", { durable: true });
    this.channel = ch;
    return ch;
  }

  async publish(topic: string, envelope: QueueMessageEnvelope): Promise<void> {
    const result = QueueMessageEnvelopeSchema.safeParse(envelope);
    if (!result.success) {
      throw new QueueValidationError(
        `publish() rejected envelope for topic "${topic}": ${result.error.message}`,
        result.error.issues,
      );
    }

    const ch = await this.getChannel();
    const content = Buffer.from(JSON.stringify(result.data));
    const published = ch.publish(this.exchangeName, topic, content, {
      persistent: true,
      messageId: envelope.eventId,
      correlationId: envelope.correlationId,
      contentType: "application/json",
    });

    if (!published) {
      throw new Error(`RabbitMQ backpressure: publish to exchange "${this.exchangeName}" was buffered`);
    }

    await ch.waitForConfirms();
    this.logger?.info(
      { eventId: envelope.eventId, eventType: envelope.eventType, topic },
      "Message published to RabbitMQ",
    );
  }

  async subscribe(
    topic: string,
    handler: MessageHandler,
    options?: SubscribeOptions,
  ): Promise<void> {
    const ch = await this.getChannel();
    const prefetch = options?.prefetch ?? 10;
    ch.prefetch(prefetch);

    const queueName = `travel.${topic}`;
    await ch.assertQueue(queueName, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": this.dlqExchangeName,
        "x-dead-letter-routing-key": `dlq.${topic}`,
      },
    });
    await ch.bindQueue(queueName, this.exchangeName, topic);

    await ch.consume(queueName, (msg) => {
      if (msg === null) return;
      void this.handleMessage(ch, msg, handler);
    });

    this.logger?.info({ topic, queueName, prefetch }, "RabbitMQ consumer started");
  }

  private async handleMessage(
    ch: AmqpChannel,
    msg: AmqpMessage,
    handler: MessageHandler,
  ): Promise<void> {
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(msg.content.toString("utf8")) as unknown;
    } catch {
      this.logger?.error(
        { routingKey: msg.fields.routingKey },
        "RabbitMQ message is not valid JSON — nacking to DLQ",
      );
      ch.nack(msg, false, false);
      return;
    }

    const result = QueueMessageEnvelopeSchema.safeParse(rawJson);
    if (!result.success) {
      this.logger?.error(
        { routingKey: msg.fields.routingKey, issues: result.error.issues },
        "RabbitMQ envelope failed schema validation — nacking to DLQ",
      );
      ch.nack(msg, false, false);
      return;
    }

    const envelope = result.data;
    let ackCalled = false;

    const handle: AckHandle = {
      ack: async () => {
        if (ackCalled) return;
        ackCalled = true;
        ch.ack(msg);
      },
      nack: async (requeue = true) => {
        if (ackCalled) return;
        ackCalled = true;
        const deliveryCount = (msg.properties.headers?.["x-delivery-count"] as number | undefined) ?? 0;
        const shouldRequeue = requeue && deliveryCount < this.maxDeliveryCount;
        ch.nack(msg, false, shouldRequeue);
        if (!shouldRequeue) {
          this.logger?.warn(
            { eventId: envelope.eventId, deliveryCount },
            "Message exhausted retries — routed to DLQ",
          );
        }
      },
    };

    try {
      await handler(envelope, handle);
    } catch (err) {
      if (!ackCalled) {
        await handle.nack(true);
      }
      this.logger?.error(
        { eventId: envelope.eventId, err },
        "RabbitMQ handler threw — message nacked",
      );
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.getChannel();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.channel !== undefined) {
      await this.channel.close().catch(() => undefined);
      this.channel = undefined;
    }
    await this.connection.close().catch(() => undefined);
  }
}
