/**
 * fault-proxy.ts — Toxiproxy wrapper for infrastructure-level fault injection (WO-099).
 *
 * Two modes:
 *   1. In-process (CI / unit-level): InMemoryFaultProxy — no real network;
 *      controls FakeAdapters and in-process latency via promise delays.
 *   2. Staging (Toxiproxy): ToxiproxyFaultProxy — issues HTTP API calls to a
 *      Toxiproxy instance running in the staging environment, injecting latency,
 *      connection drops, and bandwidth limits in front of Redis, Postgres, and
 *      supplier egress endpoints.
 *
 * Usage in scenarios:
 *   const proxy = process.env['RESILIENCE_TARGET'] === 'staging'
 *     ? new ToxiproxyFaultProxy(TOXIPROXY_API_URL)
 *     : new InMemoryFaultProxy();
 *   await proxy.addLatency('redis', 2000);
 *   // ... run scenario ...
 *   await proxy.reset('redis');
 *
 * Constraint: staging injection must only target environments tagged with
 * Environment=staging; production injection is never permitted.
 */

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface FaultProxy {
  /** Inject `latencyMs` ms of latency on the named upstream. */
  addLatency(upstream: string, latencyMs: number): Promise<void>;
  /** Drop all connections to the named upstream (blackhole). */
  blackhole(upstream: string): Promise<void>;
  /** Remove all toxics from the named upstream and restore normal operation. */
  reset(upstream: string): Promise<void>;
  /** Remove all toxics from all upstreams. */
  resetAll(): Promise<void>;
}

// ---------------------------------------------------------------------------
// InMemoryFaultProxy — CI / unit-level test double
// ---------------------------------------------------------------------------

export interface InMemoryFaultState {
  latencyMs: number;
  blackholed: boolean;
}

export class InMemoryFaultProxy implements FaultProxy {
  private readonly _states = new Map<string, InMemoryFaultState>();

  getState(upstream: string): InMemoryFaultState {
    return this._states.get(upstream) ?? { latencyMs: 0, blackholed: false };
  }

  async addLatency(upstream: string, latencyMs: number): Promise<void> {
    const current = this.getState(upstream);
    this._states.set(upstream, { ...current, latencyMs });
  }

  async blackhole(upstream: string): Promise<void> {
    this._states.set(upstream, { latencyMs: 0, blackholed: true });
  }

  async reset(upstream: string): Promise<void> {
    this._states.delete(upstream);
  }

  async resetAll(): Promise<void> {
    this._states.clear();
  }

  /** Build a delay promise that honours the current latency state. */
  delayForUpstream(upstream: string): Promise<void> {
    const state = this.getState(upstream);
    if (state.blackholed) {
      return new Promise<void>(() => { /* intentionally hangs */ });
    }
    if (state.latencyMs > 0) {
      return new Promise<void>((resolve) => setTimeout(resolve, state.latencyMs));
    }
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// ToxiproxyFaultProxy — staging-level Toxiproxy HTTP API
// ---------------------------------------------------------------------------

export class ToxiproxyFaultProxy implements FaultProxy {
  constructor(private readonly apiBaseUrl: string) {}

  async addLatency(upstream: string, latencyMs: number): Promise<void> {
    const url = `${this.apiBaseUrl}/proxies/${upstream}/toxics`;
    const body = JSON.stringify({
      name: `latency_${upstream}_${Date.now()}`,
      type: "latency",
      stream: "upstream",
      attributes: { latency: latencyMs, jitter: 0 },
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      throw new Error(`ToxiproxyFaultProxy.addLatency failed: ${res.status} ${await res.text()}`);
    }
  }

  async blackhole(upstream: string): Promise<void> {
    const url = `${this.apiBaseUrl}/proxies/${upstream}/toxics`;
    const body = JSON.stringify({
      name: `blackhole_${upstream}`,
      type: "timeout",
      stream: "upstream",
      attributes: { timeout: 0 },
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      throw new Error(`ToxiproxyFaultProxy.blackhole failed: ${res.status}`);
    }
  }

  async reset(upstream: string): Promise<void> {
    const listUrl = `${this.apiBaseUrl}/proxies/${upstream}/toxics`;
    const listRes = await fetch(listUrl);
    if (!listRes.ok) return;
    const toxics = (await listRes.json()) as Array<{ name: string }>;
    for (const toxic of toxics) {
      await fetch(`${listUrl}/${toxic.name}`, { method: "DELETE" });
    }
  }

  async resetAll(): Promise<void> {
    const res = await fetch(`${this.apiBaseUrl}/reset`, { method: "POST" });
    if (!res.ok) {
      throw new Error(`ToxiproxyFaultProxy.resetAll failed: ${res.status}`);
    }
  }
}
