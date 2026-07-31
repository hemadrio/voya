# ADR-0006: Queue Port Abstraction: RabbitMQ Locally, SQS FIFO in Production

**Status:** Accepted
**Date:** 2026-07-31
**Deciders:** Platform Engineering, Infrastructure
**Owner:** Platform Engineering

---

## Context

The platform publishes two categories of asynchronous messages: booking lifecycle events (booking confirmed, cancelled, failed) on a FIFO queue so ordering guarantees prevent duplicate-notification race conditions, and notification delivery (email triggers) on a standard queue where at-least-once delivery is sufficient.

The local development loop must run without AWS credentials. Production must use a managed service with durable storage, dead-letter queues, and IAM authentication. The chosen queue technology must not appear directly in service domain logic — message-broker coupling has historically been a source of irreversible architectural lock-in.

---

## Decision

The `@travel/queue` package exposes a port interface (`QueuePublisher`, `QueueConsumer`). In local development and CI the port is backed by RabbitMQ 3.13 running in Docker Compose. In production the port is backed by two SQS queues: one FIFO queue (`booking-events.fifo`) for ordered booking lifecycle events and one standard queue (`notification-events`) for email delivery. The port contract is enforced by the TypeScript interface; swapping the adapter requires no changes to calling service code.

---

## Rationale

RabbitMQ in Docker Compose keeps the local development loop fast: no AWS credentials, no SDK initialisation, sub-millisecond local round-trip. SQS in production inherits managed durability, dead-letter queues, and IAM task-role authentication at effectively zero operational overhead. The port pattern means no service imports `amqplib` or `@aws-sdk/client-sqs` directly — the adapter is injected at startup, which is the same dependency-injection pattern used for Prisma and Express in the domain layer (ADR-0005).

Kafka was evaluated and rejected: Kafka's strong-ordering and high-throughput guarantees are over-scaled for the platform's current load of ~3,000 notification events per day. The operational cost of managing a Kafka cluster (replication factor, partition sizing, consumer group lag monitoring) is disproportionate.

AmazonMQ (managed RabbitMQ) was considered as a single-environment solution. It was rejected because it requires a running AmazonMQ broker in every developer environment (additional AWS cost and a 5-minute provision time) or a hybrid local/cloud setup. The port abstraction achieves the same result at lower cost.

---

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Kafka (MSK in production, Kafka in Docker locally) | Over-scaled for ~3 k notifications/day; MSK minimum instance size is cost-prohibitive for a Phase 0 platform; partition sizing decisions add complexity before traffic is known |
| AmazonMQ (managed RabbitMQ everywhere, including dev) | Requires AWS credentials in the developer loop; 5-minute provision time breaks the fast-feedback loop; per-broker cost for each developer environment |
| Direct SMTP queue (no message broker) | No ordering guarantees; notification retries require ad-hoc retry logic; no dead-letter queue; violates the separation between booking state transitions and notification delivery |
| Redis Pub/Sub | At-most-once delivery (not at-least-once); messages are lost if the consumer is offline; does not satisfy the durable-delivery requirement for booking confirmations |

---

## Consequences

**Positive:**
- Local development runs without AWS credentials or network access to AWS.
- Service code is decoupled from the messaging technology: the adapter can be replaced without touching domain logic.
- SQS FIFO ordering prevents duplicate-notification race conditions on booking confirmation.
- SQS dead-letter queues surface failed message processing before it becomes a silent data loss.

**Negative / Trade-offs:**
- The port interface must be kept in sync with both adapter implementations; a feature available in SQS but not in RabbitMQ (e.g. message groups beyond FIFO) cannot be exposed through the port.
- RabbitMQ in Docker Compose requires the developer to run `docker compose up` before testing notification flows; this is documented in `docs/local-development.md`.

**Neutral / Notes:**
- Message envelope schemas (including `correlationId`) are defined in `@travel/contracts/events` and are shared between both adapters.
- The SQS FIFO queue uses `bookingId` as the `MessageGroupId` to preserve per-booking event ordering while allowing different bookings to be processed in parallel.

---

## Status History

| Date | Status | Note |
|---|---|---|
| 2026-07-31 | Accepted | Ratified from architecture artifact; sponsor-confirmed decision |
