import { SqsAdapter } from "../../src/adapters/SqsAdapter.js";
import { QueueValidationError } from "../../src/QueueValidationError.js";
import {
  bookingConfirmedEnvelope,
  bookingCancelledEnvelope,
  INVALID_OCCURRED_AT,
} from "../fixtures/envelopes.js";
import type { QueueMessageEnvelope } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Minimal SQSClient mock
// ---------------------------------------------------------------------------

type CommandName =
  | "SendMessageCommand"
  | "ReceiveMessageCommand"
  | "DeleteMessageCommand"
  | "ChangeMessageVisibilityCommand";

function makeMockClient(
  responses: Partial<Record<CommandName, unknown>> = {},
): {
  send: jest.Mock;
  destroy: jest.Mock;
} {
  return {
    send: jest.fn((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name as CommandName;
      const resp = responses[name];
      return Promise.resolve(resp ?? {});
    }),
    destroy: jest.fn(),
  };
}

const QUEUE_URLS = { "domain-events": "https://sqs.us-east-1.amazonaws.com/123456789/domain-events.fifo" };
const TOPIC = "domain-events";

// ---------------------------------------------------------------------------
// publish() tests
// ---------------------------------------------------------------------------

describe("SqsAdapter.publish()", () => {
  it("sends a SendMessageCommand with correct FIFO fields", async () => {
    const client = makeMockClient({ SendMessageCommand: { MessageId: "msg-001" } });
    const adapter = new SqsAdapter({
      client: client as never,
      queueUrls: QUEUE_URLS,
    });

    const envelope = bookingConfirmedEnvelope();
    await adapter.publish(TOPIC, envelope);

    expect(client.send).toHaveBeenCalledTimes(1);
    const [cmd] = client.send.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(cmd.input["MessageGroupId"]).toBe(envelope.userId);
    expect(cmd.input["MessageDeduplicationId"]).toBe(envelope.eventId);
    expect(cmd.input["QueueUrl"]).toBe(QUEUE_URLS[TOPIC]);
  });

  it("throws QueueValidationError for an invalid envelope", async () => {
    const client = makeMockClient();
    const adapter = new SqsAdapter({ client: client as never, queueUrls: QUEUE_URLS });

    await expect(
      adapter.publish(TOPIC, INVALID_OCCURRED_AT as unknown as QueueMessageEnvelope),
    ).rejects.toBeInstanceOf(QueueValidationError);
    expect(client.send).not.toHaveBeenCalled();
  });

  it("throws on unknown topic", async () => {
    const client = makeMockClient();
    const adapter = new SqsAdapter({ client: client as never, queueUrls: QUEUE_URLS });
    const envelope = bookingConfirmedEnvelope();

    await expect(adapter.publish("unknown-topic", envelope)).rejects.toThrow(
      'no queue URL configured for topic "unknown-topic"',
    );
  });

  it("sets correlationId as a message attribute", async () => {
    const client = makeMockClient({ SendMessageCommand: {} });
    const adapter = new SqsAdapter({ client: client as never, queueUrls: QUEUE_URLS });
    const envelope = bookingConfirmedEnvelope({ correlationId: "trace-corr-xyz" });

    await adapter.publish(TOPIC, envelope);

    const [cmd] = client.send.mock.calls[0] as [{ input: Record<string, Record<string, unknown>> }];
    expect(cmd.input["MessageAttributes"]?.["correlationId"]).toMatchObject({
      DataType: "String",
      StringValue: "trace-corr-xyz",
    });
  });

  it("sets eventType as a message attribute", async () => {
    const client = makeMockClient({ SendMessageCommand: {} });
    const adapter = new SqsAdapter({ client: client as never, queueUrls: QUEUE_URLS });
    const envelope = bookingCancelledEnvelope();

    await adapter.publish(TOPIC, envelope);

    const [cmd] = client.send.mock.calls[0] as [{ input: Record<string, Record<string, unknown>> }];
    expect(cmd.input["MessageAttributes"]?.["eventType"]).toMatchObject({
      DataType: "String",
      StringValue: "booking.cancelled",
    });
  });
});

// ---------------------------------------------------------------------------
// Backoff calculation
// ---------------------------------------------------------------------------

describe("SqsAdapter — retry backoff", () => {
  it("isHealthy() returns true when SQS responds", async () => {
    const client = makeMockClient({ ReceiveMessageCommand: { Messages: [] } });
    const adapter = new SqsAdapter({ client: client as never, queueUrls: QUEUE_URLS });
    expect(await adapter.isHealthy()).toBe(true);
  });

  it("isHealthy() returns false when SQS throws", async () => {
    const client = {
      send: jest.fn().mockRejectedValue(new Error("connection refused")),
      destroy: jest.fn(),
    };
    const adapter = new SqsAdapter({ client: client as never, queueUrls: QUEUE_URLS });
    expect(await adapter.isHealthy()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe("SqsAdapter.close()", () => {
  it("calls client.destroy() on close", async () => {
    const client = makeMockClient();
    const adapter = new SqsAdapter({ client: client as never, queueUrls: QUEUE_URLS });
    await adapter.close();
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — second close does not throw", async () => {
    const client = makeMockClient();
    const adapter = new SqsAdapter({ client: client as never, queueUrls: QUEUE_URLS });
    await adapter.close();
    await expect(adapter.close()).resolves.toBeUndefined();
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });
});
