import { createQueueAdapter } from "../../src/factory.js";

// ---------------------------------------------------------------------------
// Factory validation tests
// ---------------------------------------------------------------------------

describe("createQueueAdapter — startup validation", () => {
  it("throws on missing QUEUE_DRIVER", async () => {
    await expect(
      createQueueAdapter({ env: {} }),
    ).rejects.toThrow("Invalid QUEUE_DRIVER");
  });

  it("throws on unknown QUEUE_DRIVER value", async () => {
    await expect(
      createQueueAdapter({ env: { QUEUE_DRIVER: "kafka" } }),
    ).rejects.toThrow("Invalid QUEUE_DRIVER");
  });

  it("throws when QUEUE_DRIVER=sqs but SQS_DOMAIN_EVENTS_QUEUE_URL is missing", async () => {
    await expect(
      createQueueAdapter({
        env: {
          QUEUE_DRIVER: "sqs",
          AWS_REGION: "us-east-1",
          // SQS_DOMAIN_EVENTS_QUEUE_URL deliberately absent
        },
      }),
    ).rejects.toThrow("SQS_DOMAIN_EVENTS_QUEUE_URL");
  });

  it("throws when QUEUE_DRIVER=sqs but SQS_DOMAIN_EVENTS_QUEUE_URL is a placeholder", async () => {
    await expect(
      createQueueAdapter({
        env: {
          QUEUE_DRIVER: "sqs",
          AWS_REGION: "us-east-1",
          SQS_DOMAIN_EVENTS_QUEUE_URL: "changeme",
        },
      }),
    ).rejects.toThrow("SQS_DOMAIN_EVENTS_QUEUE_URL");
  });

  it("throws when QUEUE_DRIVER=rabbitmq but RABBITMQ_URL is missing", async () => {
    await expect(
      createQueueAdapter({
        env: {
          QUEUE_DRIVER: "rabbitmq",
          // RABBITMQ_URL deliberately absent
        },
      }),
    ).rejects.toThrow("RABBITMQ_URL");
  });

  it("throws when QUEUE_DRIVER=rabbitmq but RABBITMQ_URL is a placeholder", async () => {
    await expect(
      createQueueAdapter({
        env: {
          QUEUE_DRIVER: "rabbitmq",
          RABBITMQ_URL: "placeholder",
        },
      }),
    ).rejects.toThrow("RABBITMQ_URL");
  });
});
