# ADR-0011: Load Test Tooling Selection

**Date:** 2026-08-01  
**Status:** Accepted  
**Deciders:** Platform Engineering, SRE  
**Story:** WO-098

---

## Context

The platform commits to concrete p95 latency budgets (search cache-hit ~180 ms, cache-miss ≤3.0 s, checkout ≤5.0 s, assistant first-token ≤2.0 s) and a throughput target of 300 rps sustained peak with a three-times spike ramp to 900 rps within ten minutes. Nothing currently verifies these commitments.

Two distinct profiles are required:

**Profile A — sustained-peak:** Two-times peak (600 rps) replay for at least fifteen minutes; this is the recurring pipeline gate required before every phase exit. The run must prove every p95 budget and every guardrail (fault rate <1%, checkout failure <0.5%, notification delivery ≥99% in 5 min).

**Profile B — spike-ramp:** Three-times peak (900 rps) ramp within ten minutes; this proves the step-scaling policy (100% PercentChangeInCapacity on a two-minute ALB RequestCountPerTarget breach). Target tracking alone typically needs 12–15 minutes for this ramp; the step policy must fire within the two-minute breach window.

Recorded production traffic does not exist before launch (Phase 1), so synthetic scenario scripts are required.

---

## Decision

Use **k6** for both profiles, with the Forge Shipping **test:speedscale** step for the recurring pipeline gate.

| Concern | Chosen approach |
|---|---|
| Scriptable ramp profiles | k6 `scenarios` API with `ramping-arrival-rate` executor |
| Threshold enforcement | k6 `thresholds` block (values loaded from external JSON) |
| Pipeline integration | `test:speedscale` stage in `.forge/pipeline.yaml` |
| Recurring gate | Profile A runs in `test:speedscale` before every staging deploy |
| Spike drill | Profile B run on-demand or pre-release (too long for every PR) |
| Metric source of truth | OpenTelemetry traces in X-Ray + CloudWatch (server-side p95) cross-checked with k6 client-side measurements |

---

## Options Considered

### Option A: k6 (selected)

**Pros:**
- Native `ramping-arrival-rate` executor models the spike ramp accurately in open-loop mode (arrival rate is independent of response time, matching real traffic).
- Thresholds block natively fails the run when a budget is breached — zero glue code needed for pipeline integration.
- SharedArray and k6 `open()` for data distribution across VUs without copying.
- Small binary; runs in CI without installing a Node.js runtime.
- Active ecosystem; xk6-timings extension available for time-to-first-byte measurement.

**Cons:**
- Uses its own Goja JS runtime (not Node.js), so `npm` ecosystem is partially unavailable. Mitigated: the load scripts themselves have minimal dependencies.
- No built-in CloudWatch metric pull; the post-run reporting step handles this separately in Node.js.

### Option B: Artillery

**Pros:** YAML-first config, native Node.js runtime, built-in plugins.  
**Cons:** Open-loop arrival rate requires Artillery Pro or custom plugin. YAML-first syntax is less expressive for conditional ramp logic.

### Option C: Locust

**Pros:** Python; rich async support.  
**Cons:** Introduces a Python toolchain dependency into an otherwise TypeScript monorepo. No native JSON threshold enforcement.

### Option D: Speedscale traffic replay only

Speedscale's `test:speedscale` step can replay recorded traffic but recorded production traffic does not exist at Phase 1 launch. Speedscale is used for the pipeline gate (replaying the k6-generated synthetic traffic profile) but cannot replace the scripted k6 generator.

---

## Consequences

- Load scripts (`tests/load/profiles/`) use the k6 JS API, not Node.js ESM. They are not part of the Turborepo build graph.
- All latency and throughput thresholds live in `tests/load/config/thresholds.json`. All values are marked `ASSUMPTION` pending sponsor ratification; re-baselining requires editing only that file.
- The `test:speedscale` stage group runs Profile A at the 600 rps gate level before staging promotion. Profile B is run on demand.
- Post-run reporting (`tests/load/reporting/generate-report.ts`) is a Node.js script that reads k6 JSON output plus CloudWatch metric data and emits a machine-readable verdict for the pipeline gate.
- Load tests must only run against environments seeded with synthetic data (BR-18). The runbook documents the environment-verification step.

---

## References

- WO-098 acceptance criteria
- `tests/load/config/thresholds.json` — externalised budget values
- `tests/load/profiles/sustained-peak.ts` — Profile A implementation
- `tests/load/profiles/spike-ramp.ts` — Profile B implementation
- `docs/runbooks/load-and-spike-run.md` — operator runbook
