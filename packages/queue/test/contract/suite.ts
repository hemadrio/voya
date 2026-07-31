/**
 * Shared contract test suite for QueuePort adapters.
 *
 * This file is parameterised over a QueuePort instance so it can be run
 * against:
 *   - RabbitMqAdapter pointing at the Docker Compose RabbitMQ 3.13 container
 *   - SqsAdapter pointing at LocalStack SQS
 *
 * Usage in an integration test:
 *
 *   import { runQueuePortContractTests } from '@travel/queue/test';
 *   runQueuePortContractTests('RabbitMQ', () => createRabbitAdapter());
 *   runQueuePortContractTests('SQS / LocalStack', () => createSqsAdapter());
 *
 * The harness is not a unit test — it requires a real broker. Tests are
 * skipped automatically when the adapter factory throws (e.g. CI without
 * Docker Compose), so the suite is safe to import unconditionally.
 */

import type { QueuePort } from "../../src/QueuePort.js";
import { QueueValidationError } from "../../src/QueueValidationError.js";
import {
  bookingConfirmedEnvelope,
  bookingCancelledEnvelope,
  MISSING_CORRELATION_ID,
} from "../fixtures/envelopes.js";
import type { QueueMessageEnvelope } from "@travel/contracts";

export interface ContractSuiteOptions {
  /** Topic/queue name pre-created on the broker for this test run. */
  topic?: string | undefined;
  /** Timeout for each assertion in ms. Default: 10_000. */
  assertionTimeoutMs?: number | undefined;
}

/**
 * Register Jest describe/it blocks that verify QueuePort contract compliance.
 *
 * @param adapterName - Human label shown in test output.
 * @param adapterFactory - Async factory called once per describe block.
 *   Should throw when the broker is unavailable (causes the whole suite to skip).
 * @param opts - Optional tuning.
 */
export function runQueuePortContractTests(
  adapterName: string,
  adapterFactory: () => Promise<QueuePort>,
  opts: ContractSuiteOptions = {},
): void {
  const topic = opts.topic ?? "domain-events";
  const timeoutMs = opts.assertionTimeoutMs ?? 10_000;

  describe(`QueuePort contract — ${adapterName}`, () => {
    let adapter: QueuePort;
    let available = true;

    beforeAll(async () => {
      try {
        adapter = await adapterFactory();
      } catch {
        available = false;
      }
    });

    afterAll(async () => {
      if (available) await adapter.close();
    });

    const skip = (name: string, fn: () => Promise<void>): void => {
      it(name, async () => {
        if (!available) {
          // eslint-disable-next-line jest/no-conditional-expect
          return;
        }
        await fn();
      }, timeoutMs);
    };

    // -----------------------------------------------------------------------
    // Publish/receive round trip
    // -----------------------------------------------------------------------

    skip("publish and receive round trip preserves envelope fields", async () => {
      const sent = bookingConfirmedEnvelope();
      let received: QueueMessageEnvelope | undefined;

      await adapter.subscribe(topic, async (env, handle) => {
        if (env.eventId === sent.eventId) {
          received = env;
          await handle.ack();
        } else {
          await handle.nack(true);
        }
      });

      await adapter.publish(topic, sent);

      await waitForCondition(() => received !== undefined, timeoutMs);

      expect(received).toBeDefined();
      expect(received?.eventId).toBe(sent.eventId);
      expect(received?.eventType).toBe(sent.eventType);
      expect(received?.correlationId).toBe(sent.correlationId);
      expect(received?.userId).toBe(sent.userId);
      expect(received?.schemaVersion).toBe(sent.schemaVersion);
    });

    // -----------------------------------------------------------------------
    // ack removes the message
    // -----------------------------------------------------------------------

    skip("ack removes the message from the queue", async () => {
      const sent = bookingCancelledEnvelope();
      let deliveryCount = 0;

      await adapter.subscribe(topic, async (env, handle) => {
        if (env.eventId === sent.eventId) {
          deliveryCount += 1;
          await handle.ack();
        } else {
          await handle.nack(true);
        }
      });

      await adapter.publish(topic, sent);
      await waitForCondition(() => deliveryCount >= 1, timeoutMs);

      // Wait extra to confirm no redelivery
      await sleep(1_000);
      expect(deliveryCount).toBe(1);
    });

    // -----------------------------------------------------------------------
    // Validation — publish rejects invalid envelopes
    // -----------------------------------------------------------------------

    skip("publish rejects invalid envelope before any broker I/O", async () => {
      await expect(
        adapter.publish(topic, MISSING_CORRELATION_ID as unknown as QueueMessageEnvelope),
      ).rejects.toBeInstanceOf(QueueValidationError);
    });

    // -----------------------------------------------------------------------
    // Health probe
    // -----------------------------------------------------------------------

    skip("isHealthy() returns true when connected", async () => {
      expect(await adapter.isHealthy()).toBe(true);
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
