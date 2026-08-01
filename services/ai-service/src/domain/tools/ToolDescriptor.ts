/**
 * Core types for the first-party tool registry.
 *
 * ToolDescriptor — shape every registered tool must satisfy.
 * ToolContext — server-side identity context forwarded to resolvers.
 * HttpClientPort — injectable HTTP abstraction so resolvers never call fetch().
 * ToolDispatchErrorCode / ToolDispatchError — discriminated error values.
 *
 * No framework imports — all types are pure data structures so the registry
 * can be unit tested without network, timers, or Express.
 */
import type { ZodTypeAny } from "zod";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type ToolDispatchErrorCode =
  | "TOOL_NOT_REGISTERED"
  | "VALIDATION_FAILED"
  | "TOOL_TARGET_NOT_ALLOWED"
  | "TOOL_TIMEOUT"
  | "TOOL_UPSTREAM_ERROR";

export interface ToolDispatchError {
  code: ToolDispatchErrorCode;
  message: string;
  /** Trace / correlation ID for log correlation. */
  reference: string;
  /** Offending field path (VALIDATION_FAILED only). */
  field?: string;
}

// ---------------------------------------------------------------------------
// ToolContext — server-side context forwarded into every resolver call.
// Values come from the JWT/session layer, NOT from model-supplied tool input.
// ---------------------------------------------------------------------------

export interface ToolContext {
  conversationId: string;
  correlationId: string;
  /** null for unauthenticated (guest) requests. */
  userId: string | null;
  /** Bearer token forwarded to the gateway for authenticated calls. */
  authToken?: string | undefined;
}

// ---------------------------------------------------------------------------
// HttpClientPort — injectable HTTP abstraction
// ---------------------------------------------------------------------------

export interface HttpResponse {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface HttpClientPort {
  get(
    url: string,
    opts: { headers: Record<string, string>; signal: AbortSignal },
  ): Promise<HttpResponse>;
}

// ---------------------------------------------------------------------------
// Minimal tracer duck type — keeps domain code free of @opentelemetry/api dep.
// ---------------------------------------------------------------------------

export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): SpanLike;
  setStatus(status: { code: 0 | 1 | 2; message?: string }): SpanLike;
  end(): void;
}

export interface TracerLike {
  startActiveSpan<T>(name: string, fn: (span: SpanLike) => T): T;
}

// ---------------------------------------------------------------------------
// ToolDescriptor
// ---------------------------------------------------------------------------

export interface ToolDescriptor {
  /** Exact name used in Anthropic tool_use blocks. */
  name: string;
  description: string;
  /** Zod schema for model-supplied input — used for both validation and JSON Schema generation. */
  inputSchema: ZodTypeAny;
  /** Declared output schema — used for documentation and output typing. */
  outputSchema: ZodTypeAny;
  /**
   * Static path suffix appended to the gateway base URL (e.g. "/v1/search/flights").
   * Must never include model-supplied values — query params carry those instead.
   */
  pathTemplate: string;
  /**
   * Resolver bound at construction time.  Receives Zod-validated input,
   * server-side context, and an injected HttpClientPort so the resolver
   * never calls the global fetch().
   */
  resolver(
    input: unknown,
    ctx: ToolContext,
    http: HttpClientPort,
    opts: { signal: AbortSignal },
  ): Promise<unknown>;
}
