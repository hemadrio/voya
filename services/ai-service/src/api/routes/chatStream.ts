/**
 * chatStream — POST /assistant/conversations/:conversationId/messages (WO-058).
 *
 * Validates the request body, resolves conversation ownership (returning 404
 * before any event is emitted for non-owners), then either:
 *   - Streams typed SSE events via SseWriter (Accept: text/event-stream or body.stream=true)
 *   - Collects events into a single JSON response (non-streaming fallback)
 *
 * A single AbortController per request is wired to both the HTTP request
 * `close` event and the Express `aborted` flag; its signal is threaded into
 * the orchestrator, model client, and every ToolDispatcher call.
 *
 * On message_end or on abort/error, the turn is persisted via appendMessage
 * with an idempotency key derived from the clientTurnId so retries are safe.
 */

import type { Request, Response, NextFunction } from "express";
import { Router } from "express";
import { randomUUID } from "crypto";
import {
  ChatRequestSchema,
  type SinkEvent,
  type ChatNonStreamResponse,
} from "@travel/contracts";
import type { ConversationRepositoryPort, Principal } from "../../domain/conversation/ConversationRepositoryPort.js";
import type { ConversationOrchestrator } from "../../domain/orchestrator/ConversationOrchestrator.js";
import { SseWriter, setStreamingHeaders, SseStallError, type WritableResponse, type HeaderSettable } from "../streaming/SseWriter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatStreamDeps {
  conversationRepository: ConversationRepositoryPort;
  orchestrator: ConversationOrchestrator;
  /** Injected clock — for test determinism. Defaults to Date.now. */
  clock?: () => number;
  sseConfig?: {
    heartbeatIntervalMs?: number;
    maxFrameBytes?: number;
    stallTimeoutMs?: number;
  };
}

// ---------------------------------------------------------------------------
// Principal extraction
// ---------------------------------------------------------------------------

function extractPrincipal(req: Request): Principal | null {
  const userId = req.headers["x-user-id"];
  if (typeof userId === "string" && userId) {
    return { type: "user", userId };
  }
  const guestId = req.headers["x-guest-session-id"];
  if (typeof guestId === "string" && guestId) {
    return { type: "guest", guestSessionId: guestId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Collect async iterable into non-streaming response object
// ---------------------------------------------------------------------------

async function collectToJson(
  events: AsyncGenerator<SinkEvent>,
  conversationId: string,
): Promise<ChatNonStreamResponse> {
  let turnId = "";
  let content = "";
  let status: "complete" | "incomplete" = "complete";
  const toolCalls: ChatNonStreamResponse["toolCalls"] = [];
  const offerCards: ChatNonStreamResponse["offerCards"] = [];
  let tokenUsage: ChatNonStreamResponse["tokenUsage"];
  // Track tool names from tool_start so tool_end can reference them
  const toolNames = new Map<string, string>();

  for await (const event of events) {
    switch (event.type) {
      case "message_start":
        turnId = event.turnId;
        break;
      case "text_delta":
        content += event.text;
        break;
      case "tool_start":
        toolNames.set(event.toolCallId, event.tool);
        break;
      case "tool_end":
        toolCalls.push({
          toolCallId: event.toolCallId,
          tool: toolNames.get(event.toolCallId) ?? "",
          status: event.status,
          summary: event.summary,
        });
        break;
      case "offer_card":
        offerCards.push({
          offerId: event.offerId,
          provenance: event.provenance,
          displayTitle: event.displayTitle,
          displaySummary: event.displaySummary,
        });
        break;
      case "message_end":
        status = event.status;
        tokenUsage = event.tokenUsage;
        break;
    }
  }

  return { turnId, conversationId, content, toolCalls, offerCards, tokenUsage, status };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createChatStreamRouter(deps: ChatStreamDeps): Router {
  const router = Router({ mergeParams: true });

  router.post("/:conversationId/messages", async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = (req as Request & { correlationId?: string }).correlationId ?? randomUUID();

    // --- 1. Validate request body ---
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      res.status(400).json({
        error: {
          code: "VALIDATION_FAILED",
          message: first?.message ?? "Invalid request body",
          field: first?.path.join("."),
        },
        reference: correlationId,
      });
      return;
    }
    const { content, clientTurnId, stream: wantStream } = parsed.data;

    // --- 2. Extract principal ---
    const principal = extractPrincipal(req);
    if (!principal) {
      res.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Authentication required" },
        reference: correlationId,
      });
      return;
    }

    const { conversationId } = req.params as { conversationId: string };

    // --- 3. Resolve conversation ownership (returns 404 for non-owners) ---
    let conversation: Awaited<ReturnType<typeof deps.conversationRepository.getConversationWithMessages>>;
    try {
      conversation = await deps.conversationRepository.getConversationWithMessages(
        principal,
        conversationId,
        { limit: 50 },
      );
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code: string }).code === "NOT_FOUND") {
        res.status(404).json({
          error: { code: "NOT_FOUND", message: "Conversation not found" },
          reference: correlationId,
        });
        return;
      }
      return next(err);
    }

    // --- 4. AbortController wired to HTTP lifecycle ---
    const controller = new AbortController();
    const onClientClose = () => controller.abort();
    req.once("close", onClientClose);
    req.once("aborted", onClientClose);

    // Derive idempotency key from the client-supplied turn ID
    const idempotencyKey = `turn:${clientTurnId}`;

    // Build history from conversation messages
    const history = conversation.messages.map((m) => ({
      role: m.role as "user" | "assistant" | "tool",
      content: m.content,
    }));

    // Tool context derived from principal
    const toolCtx = {
      conversationId,
      correlationId,
      userId: principal.type === "user" ? principal.userId : null,
    };

    const serverTurnId = randomUUID();

    // --- 5. Determine streaming mode ---
    const acceptHeader = req.headers["accept"] ?? "";
    const useStream = wantStream === true || acceptHeader.includes("text/event-stream");

    if (useStream) {
      // --- 6a. Streaming path ---
      setStreamingHeaders(res as unknown as HeaderSettable);
      const writer = new SseWriter(res as unknown as WritableResponse, deps.sseConfig);

      let turnStatus: "complete" | "incomplete" = "complete";
      let turnTokenUsage: { inputTokens: number; outputTokens: number } | undefined;
      let accumulatedContent = "";

      try {
        const events = deps.orchestrator.runTurn(
          serverTurnId,
          conversationId,
          content,
          history,
          toolCtx,
          controller.signal,
        );

        for await (const event of events) {
          if (controller.signal.aborted) break;
          await writer.writeEvent(event);

          // Track for persistence
          if (event.type === "text_delta") accumulatedContent += event.text;
          if (event.type === "message_end") {
            turnStatus = event.status;
            turnTokenUsage = event.tokenUsage;
          }
        }
      } catch (err) {
        if (controller.signal.aborted || err instanceof SseStallError) {
          turnStatus = "incomplete";
        } else {
          // Mid-stream failure — emit sanitised error event
          await writer.writeError(
            "TURN_FAILED",
            "An error occurred processing your message",
            correlationId,
          ).catch(() => {});
          turnStatus = "incomplete";
        }
      } finally {
        req.removeListener("close", onClientClose);
        req.removeListener("aborted", onClientClose);
      }

      // Persist the turn (idempotent)
      await deps.conversationRepository.appendMessage(principal, conversationId, {
        role: "assistant",
        content: accumulatedContent,
        tokenCount: (turnTokenUsage?.outputTokens ?? 0),
        idempotencyKey,
        resolvedSlots: conversation.conversation.resolvedSlots,
      }).catch(() => {/* persistence failure — already streamed, log silently */});

      writer.close();
    } else {
      // --- 6b. Non-streaming path (same orchestration path) ---
      try {
        const events = deps.orchestrator.runTurn(
          serverTurnId,
          conversationId,
          content,
          history,
          toolCtx,
          controller.signal,
        );

        const jsonResponse = await collectToJson(events, conversationId);

        // Persist the completed turn
        await deps.conversationRepository.appendMessage(principal, conversationId, {
          role: "assistant",
          content: jsonResponse.content,
          tokenCount: jsonResponse.tokenUsage?.outputTokens ?? 0,
          idempotencyKey,
        }).catch(() => {});

        res.status(200).json(jsonResponse);
      } catch (err) {
        return next(err);
      } finally {
        req.removeListener("close", onClientClose);
        req.removeListener("aborted", onClientClose);
      }
    }
  });

  return router;
}
