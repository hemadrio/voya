# Target Ratification Package — Phase 1 Exit Gate

**Gate date:** 2026-10-23
**Decision owner (product sponsor):** _[name to be filled by sponsor]_
**Re-baselining commitment:** 30 days after live traffic begins (target: 2026-11-22)
**Prepared by:** Engineering — Observability workstream

---

## Purpose

Eight measurement targets remain marked as **assumptions** in the platform requirements.
This document provides:

1. The source citation for each target (where it came from)
2. Current observed value or explicit "not-yet-measurable" status
3. The recommended launch commitment
4. A decision field for the sponsor to ratify, defer, or revise each target

A ratified or deferred decision resolves Open Questions Q3 and Q4 below and
unblocks the Phase 1 exit gate on 2026-10-23.

---

## Open Question Q3 — Target Acceptance

**Q3:** Are the proposed conversion, attachment, latency, and cost targets accepted
as launch commitments by the product sponsor?

> **Decision:** _[ ] Accepted as stated   [ ] Revised — see notes   [ ] Deferred to 30-day re-baseline_
>
> **Decision owner:** _________________________
> **Decision date:** _________________________
> **Notes:** _________________________

---

## Open Question Q4 — Primary Success Metric

**Q4:** Which single primary success metric wins when metrics conflict?
(Example: raising assistant cost per booking could increase the search-to-booking rate.)

> **Decision:** _[ ] Search-to-booking rate   [ ] Assistant cost per booking   [ ] Other: ___________
>
> **Rationale:** _________________________
> **Decision owner:** _________________________
> **Decision date:** _________________________

---

## Assumed Targets — Ratification Table

Each row uses the format:
- **Status**: `OBSERVED` (have data), `NOT_YET_MEASURABLE` (leading indicator only), or `ASSUMED` (no live data yet)
- **Decision**: blank fields to be filled by the sponsor on or before 2026-10-23

---

### Target 1 — Search-to-Booking Conversion Rate

| Field | Value |
|---|---|
| **Target** | 4.0% of search sessions result in a booking |
| **Source** | PRD-Spec Business Objective O1; assumed from industry benchmark (OTA search-to-book median ~3–6%) |
| **Status** | `NOT_YET_MEASURABLE` — requires ≥ 30 days of live search+payment traffic |
| **Earliest measurable date** | 30 days post-launch |
| **Leading indicator** | Funnel dashboard panel "Search-to-Booking Rate" shows synthetic and early traffic rate |
| **Recommended launch commitment** | 4.0% as a 90-day reviewed target; flag if < 2% in first 30 days |
| **Sponsor decision** | _[ ] Accept 4.0%   [ ] Revise to ______   [ ] Defer to re-baseline_ |
| **Decision date** | ___________________________ |

---

### Target 2 — Assistant-Attributed Conversion Rate

| Field | Value |
|---|---|
| **Target** | 20% of assistant-initiated sessions result in a confirmed booking |
| **Source** | PRD-Spec O2; internal estimate based on TREK benchmark task-completion rates |
| **Status** | `NOT_YET_MEASURABLE` — requires live assistant traffic |
| **Earliest measurable date** | 30 days post-launch |
| **Leading indicator** | Funnel dashboard panel "Assistant Conversion Rate" |
| **Recommended launch commitment** | 20% as a 90-day reviewed target; alert if < 10% at 30 days |
| **Sponsor decision** | _[ ] Accept 20%   [ ] Revise to ______   [ ] Defer to re-baseline_ |
| **Decision date** | ___________________________ |

---

### Target 3 — Multi-Category Attachment Rate ⚠️ Leading Indicator Only

| Field | Value |
|---|---|
| **Target** | 30% of booked travelers add a second travel category within 90 days |
| **Source** | PRD-Spec O3; assumed from cross-sell benchmark for OTA itinerary products |
| **Status** | `NOT_YET_MEASURABLE` — **90-day window cannot close before the Phase 1 gate** |
| **Earliest measurable date** | 2027-01-21 (90 days after 2026-10-23 gate date) |
| **Leading indicator** | Same-session multi-category attachment visible in funnel MULTI-category panel; does not capture return-visit attachment |
| **Caveat** | Final value requires 90 days of post-booking observation. Any number reported at gate is a proxy only. |
| **Recommended launch commitment** | Accept same-session proxy ≥ 15% as a phase-gate signal; commit to full 90-day target re-review by 2027-01-21 |
| **Sponsor decision** | _[ ] Accept proxy signal   [ ] Accept full 30% commitment regardless   [ ] Defer_ |
| **Decision date** | ___________________________ |

---

### Target 4 — Guest-to-Registration Rate

| Field | Value |
|---|---|
| **Target** | 25% of guest search sessions convert to registered accounts |
| **Source** | PRD-Spec O4; assumed from e-commerce guest-to-registered conversion norms |
| **Status** | `NOT_YET_MEASURABLE` — requires live guest + registration traffic |
| **Earliest measurable date** | 30 days post-launch |
| **Leading indicator** | Funnel dashboard "Guest-to-Registration" panel |
| **Recommended launch commitment** | 25% as a 30-day reviewed target |
| **Sponsor decision** | _[ ] Accept 25%   [ ] Revise to ______   [ ] Defer to re-baseline_ |
| **Decision date** | ___________________________ |

---

### Target 5 — Preference Adoption Rate

| Field | Value |
|---|---|
| **Target** | 50% of registered users set at least one travel preference |
| **Source** | PRD-Spec O5; assumed engagement target |
| **Status** | `NOT_YET_MEASURABLE` — requires registered user base |
| **Earliest measurable date** | 30 days post-launch |
| **Leading indicator** | `preference_saved` funnel event rate per registered user |
| **Recommended launch commitment** | 50% as a 90-day reviewed target |
| **Sponsor decision** | _[ ] Accept 50%   [ ] Revise to ______   [ ] Defer to re-baseline_ |
| **Decision date** | ___________________________ |

---

### Target 6 — Conversation Completion Rate

| Field | Value |
|---|---|
| **Target** | 70% of started conversations reach a handoff-to-booking or explicit end state |
| **Source** | PRD-Spec O6; based on internal LLM assistant trial data |
| **Status** | `NOT_YET_MEASURABLE` — requires live assistant conversations |
| **Earliest measurable date** | 30 days post-launch |
| **Leading indicator** | Funnel dashboard "Conversation Completion" panel |
| **Recommended launch commitment** | 70% as a 30-day reviewed target; alert if < 50% at 14 days |
| **Sponsor decision** | _[ ] Accept 70%   [ ] Revise to ______   [ ] Defer to re-baseline_ |
| **Decision date** | ___________________________ |

---

### Target 7 — Search Latency p95 ≤ 3.0 s / 5.0 s Alert

| Field | Value |
|---|---|
| **Target** | Search overall p95 ≤ 3,000 ms; hard alert at 5,000 ms |
| **Source** | PRD-Spec NFR Performance — committed architecture number (locals.tf `threshold_search_p95_warning_ms = 3000`) |
| **Status** | `OBSERVED` — SLO alarm active in Terraform; staging metrics available |
| **Current observed value** | _To be filled from staging dashboard at gate review_ |
| **Recommended launch commitment** | Commit to 3,000 ms p95 warning; 5,000 ms triggers page |
| **Sponsor decision** | _[ ] Accepted as committed architecture number_ |
| **Decision date** | ___________________________ |

---

### Target 8 — Assistant Cost per Completed Booking ≤ USD 0.75

| Field | Value |
|---|---|
| **Target** | USD 0.75 ceiling per confirmed booking attributed to the assistant |
| **Source** | PRD-Spec BR-cost-01; enforced at runtime by CostGovernor (pre-call cap) |
| **Status** | `OBSERVED` — alarm active (CRITICAL-assistant-cost-per-booking-ceiling-breach); staging metrics available |
| **Current observed value** | _To be filled from staging dashboard at gate review_ |
| **Recommended launch commitment** | USD 0.75 hard ceiling already enforced by CostGovernor; ratify as the commercial commitment |
| **Sponsor decision** | _[ ] Accept USD 0.75 ceiling   [ ] Revise to _______ |
| **Decision date** | ___________________________ |

---

## Not-Yet-Measurable: Long-Horizon Targets

These two targets **cannot produce final values before the Phase 1 exit gate** because
the observation window exceeds the gate date.

| Metric | Observation Window | Gate Date | Earliest Final Value |
|---|---|---|---|
| Multi-category attachment rate (Target 3) | 90 days post-booking | 2026-10-23 | 2027-01-21 |
| 180-day repeat-booking rate | 180 days post-booking | 2026-10-23 | 2027-04-21 |

**Repeat-Booking Rate note:** A 20% repeat-booking rate within 180 days is a business objective
from PRD-Spec O7 but does not appear in the eight assumed targets table above because
it was classified as a Phase 2 measurement in the rollout plan. It is included here for
completeness. The 30-day re-baseline (2026-11-22) will define the leading-indicator proxy.

---

## Re-Baselining Commitment

Regardless of which targets are ratified at the gate, the engineering team commits to:

1. **2026-11-22** (30 days post-launch): Publish observed values for all seven 30-day-measurable
   targets against the ratified commitments, plus the same-session proxy for attachment.
2. **2027-01-21** (90 days post-launch): Publish the final 90-day multi-category attachment rate.
3. **2027-04-21** (180 days post-launch): Publish the 180-day repeat-booking rate.

All re-baselines are published via the operational dashboard and a formal measurement review.

---

## Approval

| Role | Name | Signature | Date |
|---|---|---|---|
| Product Sponsor | | | |
| Engineering Lead | | | |
| SRE Lead | | | |
