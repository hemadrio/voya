/**
 * Structured logger for the retention worker.
 * Writes JSON lines to stdout. Never includes PII, stack traces, or
 * provider payloads in log output (BR-13).
 */

import type { PurgeLogger } from "@travel/retention";

export function buildLogger(): PurgeLogger {
  const write = (level: string, context: Record<string, unknown>, message: string) => {
    const entry = JSON.stringify({ level, message, ...context, timestamp: new Date().toISOString() });
    process.stdout.write(entry + "\n");
  };

  return {
    info: (context, message) => write("info", context, message),
    warn: (context, message) => write("warn", context, message),
    error: (context, message) => write("error", context, message),
  };
}
