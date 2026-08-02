import { RabbitMqAdapter } from "../../src/adapters/RabbitMqAdapter.js";
import { QueueValidationError } from "../../src/QueueValidationError.js";
import {
  bookingConfirmedEnvelope,
  bookingCancelledEnvelope,
  INVALID_OCCURRED_AT,
} from "../fixtures/envelopes.js";
import type { QueueMessageEnvelope } from "@travel/contracts";
import type { AmqpChannel, AmqpConnection, AmqpMessage } from "../../src/adapters/RabbitMqAdapter.js";

// ---------------------------------------------------------------------------
// Minimal AMQP channel/connection fakes
// ---------------------------------------------------------------------------

function makeMessage(
  content: Buffer,
  headers: Record<string, unknown> = {},
  correlationId?: string,
): AmqpMessage {
  return {
    content,
    fields: { deliveryTag: 1, redelivered: false, routingKey: "booking.confirmed" },
    properties: {
      headers,
      messageId: undefined,
      correlationId,
    },
  };
}

function makeChannel(): {
  mock: jest.Mocked<AmqpChannel>;
  consumeHandler: { fn: ((msg: AmqpMessage | null) => void) | undefined };
} {
  const consumeHandler: { fn: ((msg: AmqpMessage | null) => void) | undefined } = {
    fn: undefined,
  };

  const mock: jest.Mocked<AmqpChannel> = {
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue({ queue: "travel.domain-events" }),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    prefetch: jest.fn(),
    publish: jest.fn().mockReturnValue(true),
    waitForConfirms: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockImplementation((_queue, handler) => {
      consumeHandler.fn = handler as (msg: AmqpMessage | null) => void;
      return Promise.resolve({});
    }),
    ack: jest.fn(),
    nack: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };

  return { mock, consumeHandler };
}

function makeConnection(channel: AmqpChannel): jest.Mocked<AmqpConnection> {
  return {
    createConfirmChannel: jest.fn().mockResolvedValue(channel),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

const TOPIC = "booking.confirmed";

// ---------------------------------------------------------------------------
// publish() tests
// ---------------------------------------------------------------------------

describe("RabbitMqAdapter.publish()", () => {
  it("publishes a valid envelope to the exchange", async () => {
    const { mock: channel } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection });

    const envelope = bookingConfirmedEnvelope();
    await adapter.publish(TOPIC, envelope);

    expect(channel.publish).toHaveBeenCalledTimes(1);
    const [exchange, routingKey, content] = channel.publish.mock.calls[0] as [
      string,
      string,
      Buffer,
      Record<string, unknown>?,
    ];
    expect(exchange).toBe("travel.events");
    expect(routingKey).toBe(TOPIC);
    const parsed = JSON.parse(content.toString("utf8")) as QueueMessageEnvelope;
    expect(parsed.eventId).toBe(envelope.eventId);
    expect(parsed.correlationId).toBe(envelope.correlationId);
  });

  it("calls waitForConfirms after publish", async () => {
    const { mock: channel } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection });

    await adapter.publish(TOPIC, bookingConfirmedEnvelope());
    expect(channel.waitForConfirms).toHaveBeenCalledTimes(1);
  });

  it("throws QueueValidationError for an invalid envelope", async () => {
    const { mock: channel } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection });

    await expect(
      adapter.publish(TOPIC, INVALID_OCCURRED_AT as unknown as QueueMessageEnvelope),
    ).rejects.toBeInstanceOf(QueueValidationError);
    expect(channel.publish).not.toHaveBeenCalled();
  });

  it("injects traceparent header when traceContext is provided", async () => {
    const { mock: channel } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection });

    const envelope = bookingConfirmedEnvelope();
    await adapter.publish(TOPIC, envelope, { traceparent: "00-abc-def-01" });

    const [, , , options] = channel.publish.mock.calls[0] as [
      string,
      string,
      Buffer,
      Record<string, Record<string, string>>?,
    ];
    expect(options?.["headers"]?.["traceparent"]).toBe("00-abc-def-01");
  });

  it("throws when publish() returns false (backpressure)", async () => {
    const { mock: channel } = makeChannel();
    channel.publish.mockReturnValue(false);
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection });

    await expect(adapter.publish(TOPIC, bookingConfirmedEnvelope())).rejects.toThrow(
      "backpressure",
    );
  });
});

// ---------------------------------------------------------------------------
// subscribe() / handleMessage() tests
// ---------------------------------------------------------------------------

describe("RabbitMqAdapter.subscribe()", () => {
  it("sets prefetch and binds the queue to the exchange", async () => {
    const { mock: channel } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection });

    await adapter.subscribe(TOPIC, jest.fn());

    expect(channel.prefetch).toHaveBeenCalledWith(10);
    expect(channel.assertQueue).toHaveBeenCalledWith(
      `travel.${TOPIC}`,
      expect.objectContaining({
        durable: true,
        arguments: expect.objectContaining({
          "x-dead-letter-exchange": "travel.events.dlq",
        }),
      }),
    );
    expect(channel.bindQueue).toHaveBeenCalledWith(
      `travel.${TOPIC}`,
      "travel.events",
      TOPIC,
    );
  });

  it("calls ack() when the handler succeeds and calls ack", async () => {
    const { mock: channel, consumeHandler } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection });

    const handler = jest.fn().mockImplementation(async (_env, handle) => {
      await handle.ack();
    });

    await adapter.subscribe(TOPIC, handler);

    const msg = makeMessage(Buffer.from(JSON.stringify(bookingConfirmedEnvelope())));
    consumeHandler.fn!(msg);

    // Give async handler time to run
    await new Promise((r) => setTimeout(r, 50));
    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it("calls nack(false, true) when handler calls nack(true)", async () => {
    const { mock: channel, consumeHandler } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection });

    const handler = jest.fn().mockImplementation(async (_env, handle) => {
      await handle.nack(true);
    });

    await adapter.subscribe(TOPIC, handler);

    const msg = makeMessage(Buffer.from(JSON.stringify(bookingConfirmedEnvelope())));
    consumeHandler.fn!(msg);

    await new Promise((r) => setTimeout(r, 50));
    expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
  });

  it("nacks immediately to DLQ for invalid JSON body", async () => {
    const { mock: channel, consumeHandler } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection });

    const handler = jest.fn();
    await adapter.subscribe(TOPIC, handler);

    const msg = makeMessage(Buffer.from("not json"));
    consumeHandler.fn!(msg);

    await new Promise((r) => setTimeout(r, 50));
    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("nacks to DLQ for a message that fails envelope schema validation", async () => {
    const { mock: channel, consumeHandler } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection });

    const handler = jest.fn();
    await adapter.subscribe(TOPIC, handler);

    const bad = { ...bookingConfirmedEnvelope(), eventType: "unknown.event" };
    const msg = makeMessage(Buffer.from(JSON.stringify(bad)));
    consumeHandler.fn!(msg);

    await new Promise((r) => setTimeout(r, 50));
    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes correlationId and traceparent via TraceContext to handler", async () => {
    const { mock: channel, consumeHandler } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection });

    let capturedTrace: Record<string, unknown> | undefined;
    const handler = jest.fn().mockImplementation(async (_env, handle, traceCtx) => {
      capturedTrace = traceCtx as Record<string, unknown>;
      await handle.ack();
    });

    await adapter.subscribe(TOPIC, handler);

    const envelope = bookingCancelledEnvelope();
    const msg = makeMessage(
      Buffer.from(JSON.stringify(envelope)),
      { traceparent: "00-xyz-abc-01" },
      envelope.correlationId,
    );
    consumeHandler.fn!(msg);

    await new Promise((r) => setTimeout(r, 50));
    expect(capturedTrace?.["correlationId"]).toBe(envelope.correlationId);
    expect(capturedTrace?.["traceparent"]).toBe("00-xyz-abc-01");
  });

  it("nacks with requeue=false after maxDeliveryCount is exceeded", async () => {
    const { mock: channel, consumeHandler } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection, maxDeliveryCount: 5 });

    const handler = jest.fn().mockImplementation(async (_env, handle) => {
      await handle.nack(true);
    });

    await adapter.subscribe(TOPIC, handler);

    // Simulate delivery count at max
    const envelope = bookingConfirmedEnvelope();
    const msg: AmqpMessage = {
      ...makeMessage(Buffer.from(JSON.stringify(envelope))),
      properties: {
        headers: { "x-delivery-count": 5 },
        messageId: undefined,
        correlationId: undefined,
      },
    };
    consumeHandler.fn!(msg);

    await new Promise((r) => setTimeout(r, 50));
    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it("nacks with requeue=true when deliveryCount < maxDeliveryCount", async () => {
    const { mock: channel, consumeHandler } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection, maxDeliveryCount: 5 });

    const handler = jest.fn().mockImplementation(async (_env, handle) => {
      await handle.nack(true);
    });

    await adapter.subscribe(TOPIC, handler);

    const envelope = bookingConfirmedEnvelope();
    const msg: AmqpMessage = {
      ...makeMessage(Buffer.from(JSON.stringify(envelope))),
      properties: {
        headers: { "x-delivery-count": 2 },
        messageId: undefined,
        correlationId: undefined,
      },
    };
    consumeHandler.fn!(msg);

    await new Promise((r) => setTimeout(r, 50));
    expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
  });

  it("ack/nack handles are idempotent — second call is a no-op", async () => {
    const { mock: channel, consumeHandler } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection });

    const handler = jest.fn().mockImplementation(async (_env, handle) => {
      await handle.ack();
      await handle.ack(); // second call must be ignored
    });

    await adapter.subscribe(TOPIC, handler);

    const msg = makeMessage(Buffer.from(JSON.stringify(bookingConfirmedEnvelope())));
    consumeHandler.fn!(msg);

    await new Promise((r) => setTimeout(r, 50));
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// isHealthy() tests
// ---------------------------------------------------------------------------

describe("RabbitMqAdapter.isHealthy()", () => {
  it("returns true when the channel can be created", async () => {
    const { mock: channel } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection });

    expect(await adapter.isHealthy()).toBe(true);
  });

  it("returns false when createConfirmChannel throws", async () => {
    const connection: jest.Mocked<AmqpConnection> = {
      createConfirmChannel: jest.fn().mockRejectedValue(new Error("connection refused")),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const adapter = new RabbitMqAdapter({ connection });
    expect(await adapter.isHealthy()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// close() tests
// ---------------------------------------------------------------------------

describe("RabbitMqAdapter.close()", () => {
  it("closes channel and connection", async () => {
    const { mock: channel } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection });

    // Trigger channel creation
    await adapter.publish(TOPIC, bookingConfirmedEnvelope());
    await adapter.close();

    expect(channel.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — second close does not throw", async () => {
    const { mock: channel } = makeChannel();
    const connection = makeConnection(channel);
    const adapter = new RabbitMqAdapter({ connection });

    await adapter.close();
    await expect(adapter.close()).resolves.toBeUndefined();
    expect(connection.close).toHaveBeenCalledTimes(1);
  });
});
