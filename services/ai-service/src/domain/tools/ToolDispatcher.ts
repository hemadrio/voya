/**
 * ToolDispatcher — validates, allow-lists, times out, and instruments
 * every tool dispatch.
 *
 * All failures are returned as values ({ ok: false, error }) — no exceptions
 * cross the dispatch boundary.  A single failed tool cannot abort a
 * conversation turn.
 *
 * SSRF defence: the resolved absolute URL host is asserted to equal the
 * configured gateway host before any egress (OWASP A01).
 *
 * No framework imports — injectable deps make unit testing infrastructure-free.
 */
import type { ToolDescriptor, ToolContext, HttpClientPort, TracerLike, SpanLike } from "./ToolDescriptor.js";
import type { ToolDispatchError, ToolDispatchErrorCode } from "./ToolDescriptor.js";
import type { ToolRegistry } from "./ToolRegistry.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type DispatchResult =
  | { ok: true; tool: string; data: unknown }
  | { ok: false; error: ToolDispatchError };

// ---------------------------------------------------------------------------
// Logger duck type
// ---------------------------------------------------------------------------

export interface ToolDispatchLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Dispatcher config
// ---------------------------------------------------------------------------

export interface ToolDispatcherConfig {
  /** Timeout per dispatch in ms. Default 2200. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 2_200;

// OTel span status codes (mirrors SpanStatusCode enum without the import).
const SPAN_OK = 1 as const;
const SPAN_ERROR = 2 as const;

// ---------------------------------------------------------------------------
// No-op tracer for when no tracer is injected
// ---------------------------------------------------------------------------

const noopSpan: SpanLike = {
  setAttribute: (_k, _v) => noopSpan,
  setStatus: (_s) => noopSpan,
  end: () => {},
};
const noopTracer: TracerLike = {
  startActiveSpan: (_name, fn) => fn(noopSpan),
};

// ---------------------------------------------------------------------------
// ToolDispatcher
// ---------------------------------------------------------------------------

export interface ToolDispatcherDeps {
  registry: ToolRegistry;
  httpClient: HttpClientPort;
  /** Optional logger — field names and value lengths only (no raw PII). */
  log?: ToolDispatchLogger | undefined;
  /** Optional OTel tracer. No-op when omitted. */
  tracer?: TracerLike | undefined;
  /** Injected clock — returns milliseconds. Defaults to Date.now(). */
  clock?: (() => number) | undefined;
  /** Provides the trace/correlation reference for error envelopes. */
  getReference?: ((ctx: ToolContext) => string) | undefined;
  config?: ToolDispatcherConfig | undefined;
}

export class ToolDispatcher {
  private readonly registry: ToolRegistry;
  private readonly httpClient: HttpClientPort;
  private readonly log: ToolDispatchLogger | undefined;
  private readonly tracer: TracerLike;
  private readonly clock: () => number;
  private readonly getReference: (ctx: ToolContext) => string;
  private readonly timeoutMs: number;

  constructor(deps: ToolDispatcherDeps) {
    this.registry = deps.registry;
    this.httpClient = deps.httpClient;
    this.log = deps.log;
    this.tracer = deps.tracer ?? noopTracer;
    this.clock = deps.clock ?? (() => Date.now());
    this.getReference = deps.getReference ?? ((ctx) => ctx.correlationId);
    this.timeoutMs = deps.config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Dispatch a tool call by name.
   *
   * Steps:
   *   1. Normalise name — trim, reject on case/whitespace mismatch (TOOL_NOT_REGISTERED).
   *   2. Look up descriptor — TOOL_NOT_REGISTERED if absent.
   *   3. Strict Zod parse of rawInput — VALIDATION_FAILED with field info if invalid.
   *   4. Assert non-object / non-null input rejected as VALIDATION_FAILED.
   *   5. Allow-list check on descriptor.pathTemplate → TOOL_TARGET_NOT_ALLOWED.
   *   6. Open OTel span assistant.tool.dispatch.
   *   7. Dispatch with AbortController timeout.
   *   8. Map 5xx / non-JSON → TOOL_UPSTREAM_ERROR.
   *   9. Return { ok: true, tool, data }.
   */
  dispatch(name: string, rawInput: unknown, ctx: ToolContext, parentSignal?: AbortSignal): Promise<DispatchResult> {
    const reference = this.getReference(ctx);

    return this.tracer.startActiveSpan("assistant.tool.dispatch", async (span: SpanLike) => {
      const startMs = this.clock();
      let outcome = "success";

      const fail = (code: ToolDispatchErrorCode, message: string, field?: string): DispatchResult => {
        outcome = code;
        return { ok: false, error: { code, message, reference, ...(field !== undefined ? { field } : {}) } };
      };

      try {
        // Step 1: normalise + look up
        const normalised = typeof name === "string" ? name.trim() : "";
        const descriptor = this.registry.get(normalised);
        if (descriptor === undefined) {
          return fail("TOOL_NOT_REGISTERED", `Tool "${normalised}" is not registered.`);
        }

        span.setAttribute("tool.name", descriptor.name);
        span.setAttribute("conversation.id", ctx.conversationId);

        // Step 2: reject non-object inputs (array, string, null, number)
        if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput)) {
          return fail(
            "VALIDATION_FAILED",
            "Tool input must be a JSON object.",
            "input",
          );
        }

        // Step 3: Zod parse — validates shape and rejects unknown fields.
        // All registered inputSchemas are already constructed with .strict()
        // so extra unknown properties are rejected by the schema itself.
        const parseResult = descriptor.inputSchema.safeParse(rawInput);
        if (!parseResult.success) {
          const firstIssue = parseResult.error.issues[0];
          const field = firstIssue?.path.join(".") ?? "input";
          const message = firstIssue?.message ?? "Validation failed";
          this.log?.warn(
            {
              tool: descriptor.name,
              fieldNames: parseResult.error.issues.map((i) => i.path.join(".")),
              issueCount: parseResult.error.issues.length,
            },
            "Tool input validation failed",
          );
          return fail("VALIDATION_FAILED", message, field);
        }

        const validatedInput = parseResult.data;

        // Step 4: allow-list check — descriptor.pathTemplate must resolve to
        // the same host as the configured gateway (OWASP A01 SSRF control).
        const { gatewayBaseUrl } = this.registry.config;
        let resolvedUrl: URL;
        try {
          resolvedUrl = new URL(descriptor.pathTemplate, gatewayBaseUrl);
        } catch {
          return fail(
            "TOOL_TARGET_NOT_ALLOWED",
            `Invalid path template for tool "${descriptor.name}".`,
          );
        }

        const gatewayHost = new URL(gatewayBaseUrl).host;
        if (resolvedUrl.host !== gatewayHost) {
          this.log?.warn(
            { tool: descriptor.name, resolvedHost: resolvedUrl.host, gatewayHost },
            "Tool target not allowed — host mismatch",
          );
          return fail(
            "TOOL_TARGET_NOT_ALLOWED",
            `Tool "${descriptor.name}" resolved to a non-gateway host.`,
          );
        }

        // Step 5: AbortController timeout + resolver call.
        // If a parentSignal is supplied, abort the tool controller when it fires.
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, this.timeoutMs);
        const parentAbortListener = () => controller.abort();
        parentSignal?.addEventListener("abort", parentAbortListener);

        let data: unknown;
        try {
          data = await descriptor.resolver(validatedInput, ctx, this.httpClient, {
            signal: controller.signal,
          });
          clearTimeout(timer);
          parentSignal?.removeEventListener("abort", parentAbortListener);
        } catch (err) {
          clearTimeout(timer);
          parentSignal?.removeEventListener("abort", parentAbortListener);
          if (timedOut || controller.signal.aborted) {
            return fail("TOOL_TIMEOUT", `Tool "${descriptor.name}" timed out after ${this.timeoutMs}ms.`);
          }
          this.log?.error(
            { tool: descriptor.name, errType: (err as Error)?.name },
            "Tool resolver threw an unexpected error",
          );
          return fail("TOOL_UPSTREAM_ERROR", `Tool "${descriptor.name}" encountered an upstream error.`);
        }

        return { ok: true, tool: descriptor.name, data };
      } finally {
        const durationMs = this.clock() - startMs;
        span.setAttribute("tool.outcome", outcome);
        span.setAttribute("tool.duration_ms", durationMs);
        span.setStatus({ code: outcome === "success" ? SPAN_OK : SPAN_ERROR });
        span.end();
      }
    });
  }
}
