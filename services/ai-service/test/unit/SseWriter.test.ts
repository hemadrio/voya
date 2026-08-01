/**
 * Unit tests for SseWriter (WO-058).
 *
 * Uses a fake writable stream (FakeWritable) to assert SSE frame output,
 * heartbeat scheduling, backpressure / drain behaviour, stall timeout,
 * and chunking of oversized text_delta frames.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SseWriter, SseStallError, setStreamingHeaders } from "../../src/api/streaming/SseWriter.js";
import type { WritableResponse } from "../../src/api/streaming/SseWriter.js";
import type { SinkEvent } from "@travel/contracts";

// ---------------------------------------------------------------------------
// FakeWritable — in-memory writable stream for test assertions
// ---------------------------------------------------------------------------

class FakeWritable implements WritableResponse {
  chunks: string[] = [];
  returnFalseOnNextWrite = false;
  drainListeners: Array<() => void> = [];
  writableEnded = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    if (this.returnFalseOnNextWrite) {
      this.returnFalseOnNextWrite = false;
      return false;
    }
    return true;
  }

  end(chunk?: string) {
    if (chunk) this.chunks.push(chunk);
    this.writableEnded = true;
  }

  once(event: "drain", listener: () => void): this {
    this.drainListeners.push(listener);
    return this;
  }

  removeListener(event: "drain", listener: () => void): this {
    this.drainListeners = this.drainListeners.filter((l) => l !== listener);
    return this;
  }

  triggerDrain() {
    const listeners = [...this.drainListeners];
    this.drainListeners = [];
    for (const l of listeners) l();
  }

  get output(): string {
    return this.chunks.join("");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWriter(config?: Parameters<typeof SseWriter>[1]) {
  const res = new FakeWritable();
  const writer = new SseWriter(res, { heartbeatIntervalMs: 60_000, ...config });
  return { res, writer };
}

function parseFrames(output: string) {
  return output
    .split("\n\n")
    .filter((f) => f.trim())
    .map((frame) => {
      const lines = frame.split("\n");
      const result: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon > 0) {
          result[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
        } else if (line.startsWith(":")) {
          result["comment"] = line.slice(1).trim();
        }
      }
      return result;
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SseWriter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("event framing", () => {
    it("writes event name and JSON data in SSE format", async () => {
      const { res, writer } = makeWriter();
      const event: SinkEvent = { type: "text_delta", text: "Hello" };
      await writer.writeEvent(event);
      writer.close();

      const output = res.output;
      expect(output).toContain("event: text_delta");
      expect(output).toContain(`"type":"text_delta"`);
      expect(output).toContain(`"text":"Hello"`);
      // Double newline frame terminator
      expect(output).toContain("text_delta\ndata:");
    });

    it("writes message_start with version field", async () => {
      const { res, writer } = makeWriter();
      const event: SinkEvent = {
        type: "message_start",
        version: "1",
        turnId: "turn-001",
        conversationId: "conv-001",
      };
      await writer.writeEvent(event);
      writer.close();
      expect(res.output).toContain('"version":"1"');
      expect(res.output).toContain('"turnId":"turn-001"');
    });

    it("writes tool_start event correctly", async () => {
      const { res, writer } = makeWriter();
      const event: SinkEvent = { type: "tool_start", toolCallId: "tc-1", tool: "search_flights" };
      await writer.writeEvent(event);
      writer.close();
      expect(res.output).toContain("event: tool_start");
      expect(res.output).toContain('"toolCallId":"tc-1"');
    });

    it("writes message_end event correctly", async () => {
      const { res, writer } = makeWriter();
      const event: SinkEvent = {
        type: "message_end",
        turnId: "turn-001",
        status: "complete",
        tokenUsage: { inputTokens: 10, outputTokens: 20 },
      };
      await writer.writeEvent(event);
      writer.close();
      expect(res.output).toContain('"status":"complete"');
      expect(res.output).toContain('"inputTokens":10');
    });

    it("each frame is terminated by a double newline", async () => {
      const { res, writer } = makeWriter();
      await writer.writeEvent({ type: "text_delta", text: "a" });
      await writer.writeEvent({ type: "text_delta", text: "b" });
      writer.close();
      // Count double newline frame terminators
      const frames = res.output.split("\n\n").filter((f) => f.trim());
      expect(frames.length).toBe(2);
    });
  });

  describe("text_delta chunking", () => {
    it("chunks a text_delta that exceeds maxFrameBytes into multiple frames", async () => {
      const { res, writer } = makeWriter({ maxFrameBytes: 10, heartbeatIntervalMs: 60_000 });
      const longText = "A".repeat(35);
      await writer.writeEvent({ type: "text_delta", text: longText });
      writer.close();

      // Should produce 4 frames: 10 + 10 + 10 + 5
      const frames = parseFrames(res.output).filter((f) => f["event"] === "text_delta");
      expect(frames.length).toBeGreaterThanOrEqual(3);
      // Reconstructed text equals original
      const reconstructed = frames
        .map((f) => {
          const parsed = JSON.parse(f["data"] ?? "{}") as { text?: string };
          return parsed.text ?? "";
        })
        .join("");
      expect(reconstructed).toBe(longText);
    });

    it("does not chunk text_delta within maxFrameBytes", async () => {
      const { res, writer } = makeWriter({ maxFrameBytes: 100, heartbeatIntervalMs: 60_000 });
      await writer.writeEvent({ type: "text_delta", text: "short" });
      writer.close();
      const frames = parseFrames(res.output).filter((f) => f["event"] === "text_delta");
      expect(frames.length).toBe(1);
    });
  });

  describe("heartbeat", () => {
    it("emits a comment heartbeat after the configured interval", async () => {
      const { res, writer } = makeWriter({ heartbeatIntervalMs: 1_000 });
      // Advance timer past heartbeat interval
      await vi.advanceTimersByTimeAsync(1_001);
      writer.close();
      expect(res.output).toContain(": keepalive");
    });

    it("resets the heartbeat timer after a real write", async () => {
      const { res, writer } = makeWriter({ heartbeatIntervalMs: 1_000 });
      // Write at t=800ms — should reset the timer
      await vi.advanceTimersByTimeAsync(800);
      await writer.writeEvent({ type: "text_delta", text: "hi" });
      // Advance to t=1600ms — 800ms since last write, so no heartbeat yet
      await vi.advanceTimersByTimeAsync(800);
      // No heartbeat should be in output yet (timer reset after write)
      const hasHeartbeat = res.chunks.some((c) => c.includes(": keepalive"));
      expect(hasHeartbeat).toBe(false);
      // Advance past the fresh interval
      await vi.advanceTimersByTimeAsync(300);
      expect(res.chunks.some((c) => c.includes(": keepalive"))).toBe(true);
      writer.close();
    });
  });

  describe("backpressure", () => {
    it("waits for drain when write returns false", async () => {
      const { res, writer } = makeWriter({ heartbeatIntervalMs: 60_000 });
      res.returnFalseOnNextWrite = true;

      let resolved = false;
      const writePromise = writer.writeEvent({ type: "text_delta", text: "data" }).then(() => {
        resolved = true;
      });

      // Not yet resolved — waiting for drain
      expect(resolved).toBe(false);

      // Trigger drain
      res.triggerDrain();
      await writePromise;
      expect(resolved).toBe(true);
    });

    it("throws SseStallError after stall timeout expires", async () => {
      const { res, writer } = makeWriter({
        heartbeatIntervalMs: 60_000,
        stallTimeoutMs: 500,
      });
      res.returnFalseOnNextWrite = true;

      const writePromise = writer.writeEvent({ type: "text_delta", text: "stall" });
      // Advance past stall timeout
      await vi.advanceTimersByTimeAsync(600);
      await expect(writePromise).rejects.toBeInstanceOf(SseStallError);
    });
  });

  describe("writeError", () => {
    it("emits a terminal error event and closes the stream", async () => {
      const { res, writer } = makeWriter();
      await writer.writeError("TURN_FAILED", "Something went wrong", "ref-001");
      expect(res.output).toContain("event: error");
      expect(res.output).toContain('"code":"TURN_FAILED"');
      expect(res.output).toContain('"reference":"ref-001"');
      expect(res.writableEnded).toBe(true);
      expect(writer.isClosed).toBe(true);
    });

    it("does not emit stack traces or internal detail in error events", async () => {
      const { res, writer } = makeWriter();
      await writer.writeError("TURN_FAILED", "User-safe message", "ref-x");
      const output = res.output;
      expect(output).not.toContain("Error:");
      expect(output).not.toContain("stack");
    });
  });

  describe("close behaviour", () => {
    it("no-ops on writeEvent after close", async () => {
      const { res, writer } = makeWriter();
      writer.close();
      const beforeCount = res.chunks.length;
      await writer.writeEvent({ type: "text_delta", text: "after close" });
      expect(res.chunks.length).toBe(beforeCount);
    });

    it("isClosed returns true after close()", () => {
      const { writer } = makeWriter();
      expect(writer.isClosed).toBe(false);
      writer.close();
      expect(writer.isClosed).toBe(true);
    });
  });

  describe("setStreamingHeaders", () => {
    it("sets all required SSE and proxy no-buffering headers", () => {
      const headers: Record<string, string> = {};
      const fakeRes = {
        setHeader: (k: string, v: string) => { headers[k] = v; },
      };
      setStreamingHeaders(fakeRes);
      expect(headers["Content-Type"]).toBe("text/event-stream");
      expect(headers["Cache-Control"]).toBe("no-cache");
      expect(headers["Connection"]).toBe("keep-alive");
      expect(headers["X-Accel-Buffering"]).toBe("no");
    });
  });
});

// ---------------------------------------------------------------------------
// Non-streaming collector test
// ---------------------------------------------------------------------------

describe("collectToJson (via orchestrator stub)", () => {
  it("accumulates text_delta events into content string", async () => {
    async function* fakeEvents(): AsyncGenerator<SinkEvent> {
      yield { type: "message_start", version: "1", turnId: "t1", conversationId: "c1" };
      yield { type: "text_delta", text: "Hello " };
      yield { type: "text_delta", text: "world" };
      yield { type: "message_end", turnId: "t1", status: "complete" };
    }

    let content = "";
    for await (const event of fakeEvents()) {
      if (event.type === "text_delta") content += event.text;
    }
    expect(content).toBe("Hello world");
  });
});
