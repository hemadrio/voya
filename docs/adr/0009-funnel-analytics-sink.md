# ADR-0009: Funnel Analytics Sink: RDS Append-Only Table + CloudWatch EMF

**Status:** Accepted
**Date:** 2026-07-31
**Deciders:** Platform Engineering, Product, Data
**Owner:** Platform Engineering

---

## Context

The platform needs funnel analytics to understand how travelers move from search → offer selection → checkout → payment confirmation, where they drop off, and which supplier offers have the highest conversion rate. This data informs both product decisions (e.g., improving the offer ranking algorithm) and SOC 2 audit evidence (booking lifecycle events for change-management controls).

The analytics volume at launch is low (initial traveler volume is small) but is expected to grow as the platform scales. The data store must not add write-path latency to the booking or payment flows; funnel events should be fire-and-forget from the service's perspective.

---

## Decision

Phase 1 (launch): Funnel events are written to an **append-only RDS table** (`funnel_events`) from the booking-service and payment-service via the SQS FIFO queue. The `funnel_events` table has `(booking_id, event_type, occurred_at, metadata JSONB)` and is INSERT-only with no UPDATE or DELETE grants for service roles. Simultaneously, each funnel event emits a **CloudWatch Embedded Metric Format (EMF)** log entry so real-time dashboards (conversion rate, average time-to-confirm) are available without a separate analytics query.

Phase 2 (scale-out, pending traffic growth): Activate the existing S3 export lifecycle rule on the `funnel_events` table (via AWS DMS CDC export to S3 in Parquet format) and create an Athena database over the S3 prefix. Athena provides SQL analytics at petabyte scale with no compute provisioning. The schema remains backward-compatible: Athena reads the same Parquet schema the DMS export produces.

---

## Rationale

An append-only RDS table satisfies the Phase 1 analytics requirement with no additional AWS services, no new access patterns, and no schema migration cost. CloudWatch EMF allows real-time metric dashboards (conversion funnel stages) from the same log stream that feeds the SIEM, avoiding a separate metrics pipeline. The S3 + Athena scale-out path is pre-wired (DMS CDC export is a configuration, not a code change) so the decision to activate it is purely operational.

A dedicated analytics database (Redshift, BigQuery, ClickHouse) was evaluated. At launch volumes it is over-engineered and adds a third data store to operate. The S3 + Athena path provides Redshift-grade SQL capability at a fraction of the provisioned cost and zero standing infrastructure.

---

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Amazon Redshift | Over-provisioned for launch volumes (~1 k events/day); minimum cluster cost is disproportionate; the S3+Athena path provides equivalent SQL without a standing cluster |
| ClickHouse (self-hosted or cloud) | Excellent columnar analytics but adds a third data store to operate; no managed AWS-native integration; requires additional IAM and VPC configuration |
| Kinesis Data Firehose → S3 | Adds streaming infrastructure before streaming volumes are justified; Firehose minimum buffering interval is 60 s, which is too coarse for real-time conversion rate dashboards |
| PostgreSQL `booking_audit_log` (re-use existing audit table) | The audit log is append-only but carries a broader set of events; analytics queries over it compete with OLTP queries; a separate `funnel_events` table with read-replica or S3 export avoids OLTP contention |
| Custom analytics service | Maintenance burden; SOC 2 evidence requirements (immutable append-only) are already satisfied by RDS + Object Lock on S3; no additional value |

---

## Consequences

**Positive:**
- No new AWS services required at launch; funnel analytics run over an existing RDS table.
- CloudWatch EMF dashboards provide real-time conversion rate without a query delay.
- The S3 + Athena scale-out path is pre-wired; activating it requires only enabling the DMS CDC export — no code change.
- The `funnel_events` table satisfies the SOC 2 append-only evidence requirement for booking lifecycle events.

**Negative / Trade-offs:**
- RDS OLTP queries and analytics queries compete for I/O on the same instance; a read replica for analytics is required if query volume grows beyond ~100 analytics queries/minute.
- CloudWatch EMF metrics have 14-day default retention; if historical trend analysis beyond 14 days is needed before the S3 scale-out is activated, the metrics must be exported manually.

**Neutral / Notes:**
- The `funnel_events` schema is INSERT-only at the application layer (no UPDATE/DELETE grants), enforced by Postgres role grants on the `funnel_writer` role.
- EMF metric namespace: `travel/funnel`; dimensions: `{stage: "search" | "offer_selected" | "checkout_started" | "payment_confirmed" | "cancelled"}`.

---

## Status History

| Date | Status | Note |
|---|---|---|
| 2026-07-31 | Accepted | Ratified from architecture artifact; scale-out path pre-wired |
