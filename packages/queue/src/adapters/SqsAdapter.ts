/**
 * SqsAdapter — QueuePort implementation for AWS SQS FIFO queues.
 *
 * Uses AWS SDK v3 SQSClient (injected) with:
 *   - SendMessageCommand for publish (FIFO: MessageGroupId=userId,
 *     MessageDeduplicationId=eventId, content-based deduplication disabled).
 *   - ReceiveMessageCommand with WaitTimeSeconds=20 for long polling.
 *   - DeleteMessageCommand for ack.
 *   - ChangeMessageVisibilityCommand for backoff-extended visibility on
 *     transient failures (nack with requeue=true).
 *
 * Retry policy:
 *   - On nack(requeue=true): ChangeMessageVisibility with exponential backoff
 *     (min 10s, max 300s), capped at maxReceiveCount (5). SQS tracks the
 *     ApproximateReceiveCount; after maxReceiveCount the message is
 *     automatically moved to the DLQ by the redrive policy.
 *   - On nack(requeue=false): DeleteMessage immediately and publish to the
 *     DLQ queue directly (for malformed messages that must never be retried).
 *
 * SQS duplicate publish (same MessageDeduplicationId within 5-minute window):
 *   SendMessageCommand returns 200 with the original MessageId — treated as
 *   success, not an error.
 *
 * Long polling empty responses are not logged (they occur on idle queues).
 */

import type {
  SQSClient,
  Message as SqsMessage,
} from "@aws-sdk/client-sqs";
import {
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import type { QueueMessageEnvelope } from "@travel/contracts";
import { QueueMessageEnvelopeSchema } from "@travel/contracts";
import type { QueuePort, MessageHandler, SubscribeOptions, AckHandle, TraceContext } from "../QueuePort.js";
import { QueueValidationError } from "../QueueValidationError.js";
/** Minimal logger surface — duck-typed so callers can inject pino, a test spy, or undefined. */
interface MinimalLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SqsAdapterOptions {
  /** Injected SQSClient. Tests supply a fake here. */
  client: SQSClient;
  /** Map from topic name to SQS queue URL. */
  queueUrls: Readonly<Record<string, string>>;
  /** Optional DLQ URL for immediate nack(false) routing. */
  dlqUrl?: string | undefined;
  /** Max SQS ApproximateReceiveCount before the adapter treats as DLQ. Default: 5. */
  maxReceiveCount?: number | undefined;
  /** Base backoff in ms for ChangeMessageVisibility. Default: 10_000. */
  baseBackoffMs?: number | undefined;
  /** Optional logger. */
  logger?: MinimalLogger | undefined;
}

// ---------------------------------------------------------------------------
// Backoff helper
// ---------------------------------------------------------------------------

function visibilityTimeoutSeconds(attempt: number, baseMs: number): number {
  const backoff = baseMs * Math.pow(2, attempt - 1);
  const jittered = backoff + Math.random() * (backoff * 0.2);
  return Math.min(Math.round(jittered / 1000), 300);
}

// ---------------------------------------------------------------------------
// SqsAdapter
// ---------------------------------------------------------------------------

export class SqsAdapter implements QueuePort {
  private readonly client: SQSClient;
  private readonly queueUrls: Readonly<Record<string, string>>;
  private readonly dlqUrl: string | undefined;
  private readonly maxReceiveCount: number;
  private readonly baseBackoffMs: number;
  private readonly logger: MinimalLogger | undefined;
  private pollingLoops: Array<AbortController> = [];
  private closed = false;

  constructor(options: SqsAdapterOptions) {
    this.client = options.client;
    this.queueUrls = options.queueUrls;
    this.dlqUrl = options.dlqUrl;
    this.maxReceiveCount = options.maxReceiveCount ?? 5;
    this.baseBackoffMs = options.baseBackoffMs ?? 10_000;
    this.logger = options.logger;
  }

  private queueUrl(topic: string): string {
    const url = this.queueUrls[topic];
    if (url === undefined) {
      throw new Error(`SqsAdapter: no queue URL configured for topic "${topic}"`);
    }
    return url;
  }

  async publish(topic: string, envelope: QueueMessageEnvelope, traceContext?: TraceContext): Promise<void> {
    const result = QueueMessageEnvelopeSchema.safeParse(envelope);
    if (!result.success) {
      throw new QueueValidationError(
        `publish() rejected envelope for topic "${topic}": ${result.error.message}`,
        result.error.issues,
      );
    }

    const validated = result.data;
    const queueUrl = this.queueUrl(topic);

    const messageAttributes: Record<string, { DataType: string; StringValue: string }> = {
      eventType: { DataType: "String", StringValue: validated.eventType },
      correlationId: { DataType: "String", StringValue: validated.correlationId },
      schemaVersion: { DataType: "Number", StringValue: String(validated.schemaVersion) },
    };
    if (traceContext?.traceparent !== undefined) {
      messageAttributes['traceparent'] = { DataType: "String", StringValue: traceContext.traceparent };
    }

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(validated),
        MessageGroupId: validated.userId,
        MessageDeduplicationId: validated.eventId,
        MessageAttributes: messageAttributes,
      }),
    );

    this.logger?.info(
      { eventId: validated.eventId, eventType: validated.eventType, topic },
      "Message published to SQS",
    );
  }

  async subscribe(
    topic: string,
    handler: MessageHandler,
    options?: SubscribeOptions,
  ): Promise<void> {
    const queueUrl = this.queueUrl(topic);
    const waitTimeSeconds = options?.waitTimeSeconds ?? 20;
    const visibilityTimeout = options?.visibilityTimeoutSeconds ?? 30;

    const controller = new AbortController();
    this.pollingLoops.push(controller);

    this.logger?.info({ topic, queueUrl, waitTimeSeconds }, "SQS consumer polling started");

    const poll = async (): Promise<void> => {
      while (!this.closed && !controller.signal.aborted) {
        let messages: SqsMessage[];
        try {
          const result = await this.client.send(
            new ReceiveMessageCommand({
              QueueUrl: queueUrl,
              MaxNumberOfMessages: 10,
              WaitTimeSeconds: waitTimeSeconds,
              VisibilityTimeout: visibilityTimeout,
              AttributeNames: ["ApproximateReceiveCount"],
              MessageAttributeNames: ["All"],
            }),
          );
          messages = result.Messages ?? [];
        } catch (err) {
          if (!this.closed) {
            this.logger?.error({ topic, err }, "SQS ReceiveMessage failed");
          }
          break;
        }

        for (const msg of messages) {
          await this.handleMessage(queueUrl, msg, handler, visibilityTimeout);
        }
      }
    };

    void poll();
  }

  private async handleMessage(
    queueUrl: string,
    msg: SqsMessage,
    handler: MessageHandler,
    defaultVisibilityTimeoutSeconds: number,
  ): Promise<void> {
    const receiptHandle = msg.ReceiptHandle;
    if (receiptHandle === undefined || receiptHandle === null) return;

    const approxCount = Number(msg.Attributes?.["ApproximateReceiveCount"] ?? "1");

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(msg.Body ?? "{}") as unknown;
    } catch {
      this.logger?.error({ messageId: msg.MessageId }, "SQS message body is not valid JSON — deleting");
      await this.deleteMessage(queueUrl, receiptHandle);
      return;
    }

    const result = QueueMessageEnvelopeSchema.safeParse(rawJson);
    if (!result.success) {
      this.logger?.error(
        { messageId: msg.MessageId, issues: result.error.issues },
        "SQS envelope failed schema validation — routing to DLQ",
      );
      await this.routeToDlq(queueUrl, receiptHandle, msg.Body ?? "");
      return;
    }

    const envelope = result.data;

    // Extract trace context from SQS MessageAttributes for context restoration.
    const traceContext: TraceContext = {
      correlationId: msg.MessageAttributes?.['correlationId']?.StringValue ?? envelope.correlationId,
      traceparent: msg.MessageAttributes?.['traceparent']?.StringValue,
    };

    let ackCalled = false;

    const handle: AckHandle = {
      ack: async () => {
        if (ackCalled) return;
        ackCalled = true;
        await this.deleteMessage(queueUrl, receiptHandle);
        this.logger?.info({ eventId: envelope.eventId }, "SQS message acked (deleted)");
      },
      nack: async (requeue = true) => {
        if (ackCalled) return;
        ackCalled = true;

        if (!requeue) {
          await this.routeToDlq(queueUrl, receiptHandle, msg.Body ?? "");
          return;
        }

        if (approxCount >= this.maxReceiveCount) {
          this.logger?.warn(
            { eventId: envelope.eventId, approxCount },
            "SQS message exhausted retries — letting SQS redrive to DLQ",
          );
          return;
        }

        const newTimeout = visibilityTimeoutSeconds(approxCount, this.baseBackoffMs);
        try {
          await this.client.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: receiptHandle,
              VisibilityTimeout: newTimeout,
            }),
          );
          this.logger?.info(
            { eventId: envelope.eventId, newTimeout, approxCount },
            "SQS visibility timeout extended for retry",
          );
        } catch (err) {
          this.logger?.error({ eventId: envelope.eventId, err }, "ChangeMessageVisibility failed");
        }
      },
    };

    try {
      await handler(envelope, handle, traceContext);
    } catch (err) {
      if (!ackCalled) {
        await handle.nack(true);
      }
      this.logger?.error({ eventId: envelope.eventId, err }, "SQS handler threw — message nacked");
    }
  }

  private async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
    );
  }

  private async routeToDlq(queueUrl: string, receiptHandle: string, body: string): Promise<void> {
    if (this.dlqUrl !== undefined) {
      try {
        await this.client.send(
          new SendMessageCommand({
            QueueUrl: this.dlqUrl,
            MessageBody: body,
            MessageGroupId: "dlq-routing",
            MessageDeduplicationId: `dlq-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          }),
        );
      } catch (err) {
        this.logger?.error({ err }, "Failed to publish to DLQ directly");
      }
    }
    await this.deleteMessage(queueUrl, receiptHandle);
  }

  async isHealthy(): Promise<boolean> {
    try {
      const topic = Object.keys(this.queueUrls)[0];
      if (topic === undefined) return false;
      const url = this.queueUrl(topic);
      await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 0,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const ctrl of this.pollingLoops) {
      ctrl.abort();
    }
    this.pollingLoops = [];
    this.client.destroy();
  }
}
