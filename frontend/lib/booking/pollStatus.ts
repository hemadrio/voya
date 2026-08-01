/**
 * Booking status polling with jittered exponential backoff (WO-068, AC9).
 *
 * Polls GET /bookings/{bookingId}/status until:
 *   - status === "confirmed"  → resolves with { status: "confirmed", reference }
 *   - status === "failed"     → resolves with { status: "failed", failureReason }
 *   - maxElapsedMs is reached → resolves with { status: "timeout" }
 *
 * The poll is cancelled on AbortSignal or when the component unmounts.
 *
 * Backoff formula:
 *   wait = min(baseMs * 2^attempt, capMs) + jitter(0..jitterMs)
 *
 * Default params: base=1000ms, cap=10000ms, jitter=500ms, maxElapsed=60000ms.
 */

import { getBookingStatus } from "../api/bookings.js";
import type { BookingStatusResponse } from "../api/bookings.js";

// ---------------------------------------------------------------------------
// Poll result
// ---------------------------------------------------------------------------

export type PollResult =
  | { status: "confirmed"; reference: string }
  | { status: "failed"; failureReason?: string }
  | { status: "timeout" };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PollConfig {
  /** Initial backoff interval in ms (default: 1000). */
  baseMs?: number;
  /** Maximum backoff cap in ms (default: 10000). */
  capMs?: number;
  /** Maximum random jitter added to each interval in ms (default: 500). */
  jitterMs?: number;
  /** Hard timeout — stop polling after this many ms (default: 60000). */
  maxElapsedMs?: number;
}

// ---------------------------------------------------------------------------
// Jitter helper (pure, injectable for tests)
// ---------------------------------------------------------------------------

export type JitterFn = (max: number) => number;
const defaultJitter: JitterFn = (max) => Math.floor(Math.random() * max);

// ---------------------------------------------------------------------------
// Delay helper
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Polling aborted", "AbortError"));
        },
        { once: true },
      );
    }
  });
}

// ---------------------------------------------------------------------------
// pollBookingStatus
// ---------------------------------------------------------------------------

/**
 * Poll booking status until confirmed, failed, or the timeout is reached.
 *
 * @param bookingId  The booking to poll.
 * @param signal     AbortSignal — cancel the poll when the component unmounts.
 * @param config     Backoff configuration.
 * @param jitter     Jitter function (injectable for deterministic tests).
 */
export async function pollBookingStatus(
  bookingId: string,
  signal?: AbortSignal,
  config: PollConfig = {},
  jitter: JitterFn = defaultJitter,
): Promise<PollResult> {
  const base = config.baseMs ?? 1_000;
  const cap = config.capMs ?? 10_000;
  const jitterMax = config.jitterMs ?? 500;
  const maxElapsed = config.maxElapsedMs ?? 60_000;

  const startTime = Date.now();
  let attempt = 0;

  for (;;) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= maxElapsed) {
      return { status: "timeout" };
    }

    if (signal?.aborted) {
      return { status: "timeout" };
    }

    let result: BookingStatusResponse;
    try {
      result = await getBookingStatus(bookingId, signal);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return { status: "timeout" };
      }
      // Network error — continue polling
      result = { status: "pending" };
    }

    if (result.status === "confirmed") {
      return { status: "confirmed", reference: result.reference ?? bookingId };
    }
    if (result.status === "failed") {
      return { status: "failed", failureReason: result.failureReason };
    }

    // Still pending — compute backoff
    const backoff = Math.min(base * Math.pow(2, attempt), cap);
    const waitMs = backoff + jitter(jitterMax);

    // Do not sleep beyond the remaining time budget
    const remaining = maxElapsed - (Date.now() - startTime);
    const effectiveWait = Math.min(waitMs, remaining);
    if (effectiveWait <= 0) return { status: "timeout" };

    try {
      await sleep(effectiveWait, signal);
    } catch {
      return { status: "timeout" };
    }

    attempt++;
  }
}
