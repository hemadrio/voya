/**
 * Typed API client — the single sanctioned way for pages and components to
 * reach the backend REST API.
 *
 * Features:
 *  - Base URL from validated env (NEXT_PUBLIC_API_BASE_URL).
 *  - Automatic Authorization: Bearer <token> header injection via a
 *    replaceable token provider (call setTokenProvider to wire in the
 *    session from your auth layer).
 *  - Query-string serialization (arrays serialized as repeated params).
 *  - Safe JSON parsing — non-JSON bodies (HTML error pages, empty 204)
 *    never throw a parse error.
 *  - Non-2xx responses are normalized into ApiError (never raw fetch errors).
 *  - Network failures / aborts become ApiError with code NETWORK_ERROR.
 *  - 401 hook — call setOn401 to register a global handler (e.g. redirect
 *    to /login or trigger a token refresh).
 */

import { env } from "../env.js";
import { ApiError } from "./errors.js";
import type { ApiErrorCode } from "./errors.js";

// ---------------------------------------------------------------------------
// Token provider — replaceable hook for auth integration
// ---------------------------------------------------------------------------

type TokenProvider = () => string | null | undefined;

let _tokenProvider: TokenProvider = () => null;
let _on401: (() => void) | null = null;

/** Register a function that returns the current access token. */
export function setTokenProvider(provider: TokenProvider): void {
  _tokenProvider = provider;
}

/** Register a callback invoked on every 401 response. */
export function setOn401(handler: () => void): void {
  _on401 = handler;
}

// ---------------------------------------------------------------------------
// Query-string serialization
// ---------------------------------------------------------------------------

function buildQuery(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        qs.append(key, String(item));
      }
    } else {
      qs.set(key, String(value));
    }
  }
  const str = qs.toString();
  return str.length > 0 ? `?${str}` : "";
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

function buildUrl(path: string, params?: Record<string, unknown>): string {
  const base = env.NEXT_PUBLIC_API_BASE_URL.replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const query = params !== undefined ? buildQuery(params) : "";
  return `${base}${normalizedPath}${query}`;
}

async function safeJson(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

interface BackendErrorBody {
  error?: { code?: string; message?: string; field?: string; fieldErrors?: Record<string, string> };
  message?: string;
}

async function parseError(res: Response): Promise<ApiError> {
  if (res.status === 401 && _on401 !== null) {
    _on401();
  }

  const body = (await safeJson(res)) as BackendErrorBody | null;
  const message =
    body?.error?.message ?? body?.message ?? `Request failed with status ${res.status}`;
  const fieldErrors = body?.error?.fieldErrors;

  return ApiError.fromStatus(res.status, message, fieldErrors);
}

async function request<T>(
  method: string,
  path: string,
  options?: {
    params?: Record<string, unknown>;
    body?: unknown;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  },
): Promise<T> {
  const token = _tokenProvider();
  const authHeader: Record<string, string> =
    token !== null && token !== undefined ? { Authorization: `Bearer ${token}` } : {};

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...authHeader,
    ...options?.headers,
  };

  if (options?.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, options?.params), {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options?.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError({
        status: 0,
        code: "NETWORK_ERROR" as ApiErrorCode,
        message: "Request was aborted",
        retryable: false,
      });
    }
    throw ApiError.networkError(
      err instanceof Error ? err.message : "Network request failed",
    );
  }

  if (!res.ok) {
    throw await parseError(res);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const data = await safeJson(res);
  return data as T;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RequestOptions {
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export const apiClient = {
  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>("GET", path, options);
  },

  post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return request<T>("POST", path, { ...options, body });
  },

  patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return request<T>("PATCH", path, { ...options, body });
  },

  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>("DELETE", path, options);
  },
};

export { ApiError } from "./errors.js";
export type { ApiErrorCode } from "./errors.js";
