# Architecture Decision Records

This directory contains the Architecture Decision Records (ADRs) for the travel platform. Each ADR captures a significant architectural decision with its context, rationale, and rejected alternatives so future engineers do not relitigate them and so SOC 2 change-management evidence exists.

## Status lifecycle

| Status | Meaning |
|---|---|
| **Proposed** | Under discussion, not yet ratified |
| **Accepted** | Ratified — the decision is active |
| **Deprecated** | No longer relevant but preserved for history |
| **Superseded** | Replaced by a later ADR; a forward link names the replacement |

A superseded ADR is **never deleted** — its history is preserved with a forward link.

## Numbering scheme

ADRs are numbered sequentially from 0001. A gap in numbering means an ADR was renumbered; the original file is replaced with a stub pointing to the new number.

## Template

See [TEMPLATE.md](TEMPLATE.md) for the required sections.

## Index

| # | Title | Status | Date |
|---|---|---|---|
| [ADR-0001](0001-logging-and-test-runner.md) | Application Log Retention and Epic Test Runner | Ratified | 2026-07-31 |
| [ADR-0002](0002-tracing-sampling-and-retention.md) | OpenTelemetry Tracing: Sampling Policy and Telemetry Cost Rationale | Accepted | 2026-07-31 |
| [ADR-0003](0003-test-framework-vitest.md) | Ratify Vitest as the Platform-Wide Unit-Test Framework | Accepted | 2026-01-15 |
| [ADR-0004](0004-observability-backend.md) | Observability Backend: X-Ray + CloudWatch over Third-Party APM | Accepted | 2026-07-31 |
| [ADR-0005](0005-zod-contracts-single-source.md) | Zod Contracts as Single Source of Truth over OpenAPI Code Generation | Accepted | 2026-07-31 |
| [ADR-0006](0006-queue-port-rabbitmq-sqs.md) | Queue Port Abstraction: RabbitMQ Locally, SQS FIFO in Production | Accepted | 2026-07-31 |
| [ADR-0007](0007-rds-proxy-connection-pooling.md) | RDS Proxy over PgBouncer for Per-Service Connection Pooling | Accepted | 2026-07-31 |
| [ADR-0008](0008-checkout-saga-compensation.md) | Checkout Saga: Commit-or-Compensate over Two-Phase Commit | Accepted | 2026-07-31 |
| [ADR-0009](0009-funnel-analytics-sink.md) | Funnel Analytics Sink: RDS Append-Only Table + CloudWatch EMF | Accepted | 2026-07-31 |
| [ADR-0010](0010-error-budget-policy.md) | Error Budget and Burn-Rate Alerting Policy | Accepted | 2026-07-31 |
