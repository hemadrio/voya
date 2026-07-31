# ADR-0004: Observability Backend: X-Ray + CloudWatch over Third-Party APM

**Status:** Accepted
**Date:** 2026-07-31
**Deciders:** Platform Engineering, Security & Compliance, Infrastructure
**Owner:** Platform Engineering

---

## Context

The platform requires distributed tracing, structured logging, and metrics across nine ECS Fargate services, three external suppliers (Amadeus, RapidAPI, Stripe), PostgreSQL, Redis, and the SQS/RabbitMQ queue layer. Without observability the ratified latency budgets (search cache-hit ~180 ms p95, checkout ack ≤5.0 s p95, assistant first-token ≤2.0 s p95) cannot be measured or defended in post-incident review.

The security policy requires that no third-party processor enters the GDPR record of processing unless absolutely necessary. AWS credentials are already issued to ECS task roles, so native AWS observability requires no additional credential grant.

ADR-0002 ratified the OpenTelemetry sampling policy and the ADOT sidecar delivery mechanism. This ADR records the higher-level choice of X-Ray + CloudWatch as the backend.

---

## Decision

Route all OpenTelemetry spans through the AWS Distro for OpenTelemetry (ADOT) sidecar to AWS X-Ray and CloudWatch. Use CloudWatch Logs for structured Pino JSON application logs, CloudWatch Metrics for capacity and error-rate signals, and CloudWatch Alarms for error-budget burn-rate alerting.

---

## Rationale

The sponsor confirmed AWS-native observability. Beyond the sponsor directive the platform avoids adding a third-party APM processor to the GDPR record of processing at no latency or fidelity benefit: X-Ray provides end-to-end trace correlation across all nine services with no egress cost, and CloudWatch Container Insights provides the container-level CPU/memory metrics required for auto-scaling decisions. IAM-based authentication means no additional secret rotation burden. CloudWatch Alarms integrate directly with the error-budget gate defined in ADR-0010.

---

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Datadog APM + logs | Adds a third-party GDPR processor; egress cost for log forwarding; additional secret (DD_API_KEY) to rotate; provides no capability gap benefit over X-Ray at the platform's scale |
| Grafana Cloud (Tempo + Loki + Prometheus) | Self-managed Grafana stack adds operational complexity on a small team; Loki ingest requires a custom forwarding sidecar; Tempo backend costs more at the projected trace volume than X-Ray per-trace pricing |
| Self-hosted Jaeger + Prometheus on ECS | Control-plane maintenance burden unjustified for a nine-service fleet; no managed retention; HA configuration requires dedicated task capacity |
| OpenSearch (ELK-compatible) | Adds another managed service (OpenSearch) with separate IAM configuration; CloudWatch Logs Insights satisfies ad-hoc query needs at lower operational cost |

---

## Consequences

**Positive:**
- Zero egress cost for traces and logs — all data stays within the AWS account.
- No third-party GDPR processor added to the record of processing.
- IAM task-role authentication — no additional credentials to rotate.
- CloudWatch Alarms integrate with the SNS-based error-budget burn-rate alerting defined in ADR-0010.
- X-Ray Service Map provides automatic service-dependency visualisation for root-cause analysis.

**Negative / Trade-offs:**
- X-Ray trace storage is capped at 30 days; longer-term trace analytics require exporting to S3 via CloudWatch Logs export.
- CloudWatch Logs Insights query syntax is non-standard compared to PromQL or Lucene; engineers must learn it.
- CloudWatch pricing scales with metric resolution; 1-minute resolution costs more than the default 5-minute; high-cardinality custom metrics require cost monitoring.

**Neutral / Notes:**
- The ADOT sidecar runs as a sidecar container in every ECS task definition; the sampler uses the `parentbased_traceidratio` strategy with the ratio configured per environment (see ADR-0002 for sampling rationale).
- Correlation IDs are the X-Ray Trace ID propagated in the `X-Amzn-Trace-Id` header by the ADOT SDK; the `reference` field in every error envelope equals this ID so a traveler screenshot resolves directly to a trace.

---

## Status History

| Date | Status | Note |
|---|---|---|
| 2026-07-31 | Accepted | Ratified from architecture artifact; sponsor-confirmed decision |
