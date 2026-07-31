/**
 * Typed API client for the travel platform web app.
 *
 * Every fetch call is wrapped so that:
 *  - 2xx responses are parsed against the caller-supplied contracts response
 *    schema; a schema mismatch throws loudly in development.
 *  - Non-2xx responses are parsed against the ErrorEnvelope schema; a
 *    malformed body (gateway HTML error page, network error) synthesises a
 *    valid envelope with a generated reference so the UI always has a
 *    reference to show the traveler.
 *
 * Returns a discriminated ApiResult<T> union — callers handle both branches
 * explicitly instead of relying on non-null assertions.
 *
 * No Express or server-only imports are present here; this module is safe
 * for the browser bundle.
 */

import { z } from "zod";
import { ErrorEnvelopeSchema } from "@travel/contracts/errors";
import type { ErrorEnvelope } from "@travel/contracts/errors";
import type { ApiResult } from "../types/index.js";

// ---------------------------------------------------------------------------
// Reference generator (fallback when the server supplies no envelope)
// ---------------------------------------------------------------------------

function generateClientReference(): string {
  // crypto.randomUUID() is available in modern browsers and Node ≥ 15.
  // Fall back to a timestamp-based id for older environments.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Synthetic envelope for unparseble error bodies
// ---------------------------------------------------------------------------

function syntheticEnvelope(status: number): ErrorEnvelope {
  return {
    error: {
      code: "INTERNAL_ERROR",
      message:
        "An unexpected error occurred. Please contact support with the reference identifier.",
    },
    reference: generateClientReference(),
  };
}

// ---------------------------------------------------------------------------
// Core fetch wrapper
// ---------------------------------------------------------------------------

/**
 * Parse a fetch Response body as JSON, returning null if the body is not
 * valid JSON (e.g. a gateway HTML error page).
 */
async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * GET a resource and parse the response body against `schema`.
 *
 * Returns `{ ok: true, data, status }` on success or
 * `{ ok: false, error: ErrorEnvelope, status }` on any failure.
 *
 * Throws only for unrecoverable network errors (no server reached).
 */
export async function apiGet<T>(
  url: string,
  schema: z.ZodType<T>,
  options?: RequestInit
): Promise<ApiResult<T>> {
  const response = await fetch(url, { ...options, method: "GET" });
  return parseResponse(response, schema);
}

/**
 * POST a JSON body and parse the response against `schema`.
 */
export async function apiPost<TBody, TResponse>(
  url: string,
  body: TBody,
  schema: z.ZodType<TResponse>,
  options?: RequestInit
): Promise<ApiResult<TResponse>> {
  const response = await fetch(url, {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(body),
  });
  return parseResponse(response, schema);
}

async function parseResponse<T>(
  response: Response,
  schema: z.ZodType<T>
): Promise<ApiResult<T>> {
  const body = await safeJson(response);

  if (!response.ok) {
    const parsed = ErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) {
      return { ok: false, error: parsed.data, status: response.status };
    }
    // Non-JSON or malformed error body — synthesise a valid envelope.
    return {
      ok: false,
      error: syntheticEnvelope(response.status),
      status: response.status,
    };
  }

  // 2xx — parse against the contracts response schema.
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // Schema mismatch: fail loudly in development, synthesise 502 in production.
    if (process.env.NODE_ENV !== "production") {
      throw new Error(
        `[api-client] Response from ${response.url} did not match the expected schema.\n` +
          parsed.error.toString()
      );
    }
    return {
      ok: false,
      error: syntheticEnvelope(502),
      status: 502,
    };
  }

  return { ok: true, data: parsed.data, status: response.status };
}
