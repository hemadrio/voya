/**
 * Single-flight token refresh helper.
 *
 * When multiple concurrent requests receive 401, only one refresh call is
 * made to the backend. All callers share the same in-flight promise so the
 * backend /auth/refresh endpoint is called exactly once per expiry cycle.
 *
 * Refresh is performed via a server action (POST /api/auth/refresh) so the
 * new tokens are written to the httpOnly cookie by the server — never
 * exposed to JavaScript.
 *
 * On success: returns true — callers retry their original request.
 * On failure: returns false — callers clear session state and redirect.
 */

let _inflight: Promise<boolean> | null = null;

/**
 * Call the token refresh endpoint. Concurrent callers share the in-flight
 * promise so at most one backend call is made per expiry window.
 */
export async function refreshTokens(): Promise<boolean> {
  if (_inflight !== null) {
    return _inflight;
  }

  _inflight = (async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}

/** Reset the in-flight promise — used in tests to ensure isolation. */
export function _resetInFlight(): void {
  _inflight = null;
}
