/**
 * SseWriter — SSE framing, drain-aware backpressure, heartbeats, stall timeout (WO-058).
 *
 * Responsibilities:
 *   - Frame typed sink events as `event: <type>\ndata: <json>\n\n`
 *   - Chunk text_delta payloads that exceed maxFrameBytes
 *   - Await the `drain` event after every write that returns false (backpressure)
 *   - Emit SSE comment heartbeats (`: keepalive\n\n`) at a configurable interval
 *     and reset the heartbeat timer after every real write
 *   - Close the connection after a configurable stall window when the client
 *     fails to consume, emitting a terminal error event first
 *
 * The response object is duck-typed so this module has no Express dependency
 * and can be unit-tested with a fake writable stream.
 */

import type { SinkEvent } from "@travel/contracts";

// ---------------------------------------------------------------------------
// Duck-typed writable response interface
// ---------------------------------------------------------------------------

export interface WritableResponse {
  write(chunk: string): boolean;
  end(chunk?: string): void;
  once(event: "drain", listener: () => void): this;
  removeListener(event: "drain", listener: () => void): this;
  writableEnded: boolean;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SseWriterConfig {
  /** Milliseconds of idle time before a heartbeat comment is emitted. Default: 10 000. */
  heartbeatIntervalMs?: number;
  /** Maximum bytes per SSE data frame before chunking. Default: 8 192. */
  maxFrameBytes?: number;
  /**
   * Milliseconds to wait for drain before declaring a stall and closing.
   * Default: 30 000.
   */
  stallTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// SseWriter
// ---------------------------------------------------------------------------

export class SseWriter {
  private closed = false;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly heartbeatIntervalMs: number;
  private readonly maxFrameBytes: number;
  private readonly stallTimeoutMs: number;

  constructor(
    private readonly res: WritableResponse,
    config: SseWriterConfig = {},
  ) {
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? 10_000;
    this.maxFrameBytes = config.maxFrameBytes ?? 8_192;
    this.stallTimeoutMs = config.stallTimeoutMs ?? 30_000;
    this.scheduleHeartbeat();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Write a typed sink event as an SSE frame.
   * Chunks text_delta events whose text exceeds maxFrameBytes.
   * Awaits drain if the write buffer is full (backpressure).
   * No-ops after the writer is closed.
   */
  async writeEvent(event: SinkEvent): Promise<void> {
    if (this.closed) return;

    if (event.type === "text_delta" && event.text.length > this.maxFrameBytes) {
      for (let i = 0; i < event.text.length; i += this.maxFrameBytes) {
        if (this.closed) return;
        await this.writeFrame(
          "text_delta",
          JSON.stringify({ type: "text_delta", text: event.text.slice(i, i + this.maxFrameBytes) }),
        );
      }
      return;
    }

    await this.writeFrame(event.type, JSON.stringify(event));
  }

  /** Emit a terminal error event and close the connection. */
  async writeError(code: string, message: string, reference: string): Promise<void> {
    if (this.closed) return;
    const payload = JSON.stringify({ type: "error", code, message, reference });
    try {
      await this.writeFrame("error", payload);
    } finally {
      this.close();
    }
  }

  /** Close the response and cancel the heartbeat timer. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearHeartbeat();
    if (!this.res.writableEnded) {
      this.res.end();
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async writeFrame(eventName: string, data: string): Promise<void> {
    this.resetHeartbeat();
    const frame = `event: ${eventName}\ndata: ${data}\n\n`;
    const ok = this.res.write(frame);
    if (!ok) {
      await this.awaitDrain();
    }
  }

  /** Emit an SSE comment line so proxies / clients know the connection is alive. */
  private async writeHeartbeatComment(): Promise<void> {
    if (this.closed || this.res.writableEnded) return;
    const ok = this.res.write(": keepalive\n\n");
    if (!ok) {
      await this.awaitDrain();
    }
  }

  /** Wait for the `drain` event with a stall timeout. */
  private awaitDrain(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stall = setTimeout(() => {
        this.res.removeListener("drain", onDrain);
        if (!this.closed) {
          this.closed = true;
          this.clearHeartbeat();
          // Best-effort terminal event — buffer may be wedged, so ignore errors
          try { this.res.write(`event: error\ndata: ${JSON.stringify({ type: "error", code: "STREAM_STALL", message: "Client stalled", reference: "" })}\n\n`); } catch { /* ignore */ }
          try { this.res.end(); } catch { /* ignore */ }
        }
        reject(new SseStallError("Stream stall: client failed to consume within timeout"));
      }, this.stallTimeoutMs);

      const onDrain = () => {
        clearTimeout(stall);
        resolve();
      };
      this.res.once("drain", onDrain);
    });
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = setTimeout(async () => {
      try {
        await this.writeHeartbeatComment();
      } catch {
        // Client disconnected — ignore
      }
      if (!this.closed) this.scheduleHeartbeat();
    }, this.heartbeatIntervalMs);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.heartbeatTimer as any).unref?.();
  }

  private resetHeartbeat(): void {
    this.clearHeartbeat();
    this.scheduleHeartbeat();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// SseStallError — thrown when the client fails to consume within stallTimeoutMs
// ---------------------------------------------------------------------------

export class SseStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseStallError";
  }
}

// ---------------------------------------------------------------------------
// setStreamingHeaders — convenience helper for Express responses
// ---------------------------------------------------------------------------

export interface HeaderSettable {
  setHeader(name: string, value: string): void;
  flushHeaders?(): void;
}

export function setStreamingHeaders(res: HeaderSettable): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Disable buffering in nginx and other reverse proxies.
  res.setHeader("X-Accel-Buffering", "no");
  // Flush response headers immediately so the client receives 200 at once.
  res.flushHeaders?.();
}
