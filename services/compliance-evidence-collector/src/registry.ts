/**
 * Evidence source adapter registry.
 *
 * The registry is the authoritative set of adapter names used for matrix
 * validation. The collector fails fast if the matrix references a name not
 * present here (AC7).
 */

import type { EvidenceSource } from "./types.js";

export class SourceRegistry {
  private readonly adapters = new Map<string, EvidenceSource>();

  register(source: EvidenceSource): this {
    if (this.adapters.has(source.name)) {
      throw new Error(`Duplicate adapter registered: "${source.name}"`);
    }
    this.adapters.set(source.name, source);
    return this;
  }

  get(name: string): EvidenceSource | undefined {
    return this.adapters.get(name);
  }

  registeredNames(): Set<string> {
    return new Set(this.adapters.keys());
  }
}
