/**
 * ConversationRepository — Prisma-backed implementation of ConversationRepositoryPort (WO-057).
 *
 * Ownership is enforced in every WHERE clause via the injected principal.
 * No operation accepts a userId/guestSessionId from the caller; ownership
 * always derives from the principal argument.
 *
 * PII redaction (redact.ts) is applied to message content before every insert.
 *
 * Cursor pagination uses an opaque base64-encoded JSON cursor { createdAt, id }.
 * A malformed or tampered cursor throws VALIDATION_FAILED.
 */

import {
  ConversationError,
  type ConversationMessage,
  type ConversationRepositoryPort,
  type ConversationSummary,
  type ConversationWithMessages,
  type CreateConversationInput,
  type AppendMessageInput,
  type PaginationOptions,
  type Principal,
} from "../../domain/conversation/ConversationRepositoryPort.js";
import { redact } from "../../domain/privacy/redact.js";

// ---------------------------------------------------------------------------
// Maximum content length (characters) — reject before insert
// ---------------------------------------------------------------------------

const MAX_CONTENT_LENGTH = 32_000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Duck-typed Prisma client interfaces — no @prisma/client import needed
// ---------------------------------------------------------------------------

export interface ConversationRow {
  id: string;
  userId: string | null;
  guestSessionId: string | null;
  title: string | null;
  status: string;
  resolvedSlots: unknown;
  tokenTotals: unknown;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  toolCalls: unknown;
  groundingRefs: unknown;
  tokenCount: number;
  idempotencyKey: string | null;
  createdAt: Date;
}

interface ConversationPrismaClient {
  conversation: {
    create(args: {
      data: {
        userId?: string | null;
        guestSessionId?: string | null;
        title?: string | null;
        status?: string;
      };
    }): Promise<ConversationRow>;
    findFirst(args: {
      where: {
        id: string;
        userId?: string | null;
        guestSessionId?: string | null;
      };
    }): Promise<ConversationRow | null>;
    findMany(args: {
      where: { userId?: string | null; guestSessionId?: string | null };
      orderBy?: { lastActivityAt?: 'asc' | 'desc' };
      cursor?: { id: string };
      take?: number;
      skip?: number;
    }): Promise<ConversationRow[]>;
    update(args: {
      where: { id: string };
      data: {
        userId?: string | null;
        guestSessionId?: string | null;
        resolvedSlots?: unknown;
        tokenTotals?: unknown;
        lastActivityAt?: Date;
        updatedAt?: Date;
      };
    }): Promise<ConversationRow>;
    updateMany(args: {
      where: {
        id: string;
        userId?: string | null;
        guestSessionId?: string | null;
      };
      data: {
        userId?: string | null;
        guestSessionId?: string | null;
        resolvedSlots?: unknown;
        tokenTotals?: unknown;
        lastActivityAt?: Date;
        updatedAt?: Date;
      };
    }): Promise<{ count: number }>;
    delete(args: { where: { id: string } }): Promise<ConversationRow | null>;
    deleteMany(args: {
      where: {
        id?: string;
        userId?: string | null;
        guestSessionId?: string | null;
        lastActivityAt?: { lt: Date };
        status?: string;
      };
    }): Promise<{ count: number }>;
  };
  conversationMessage: {
    create(args: {
      data: {
        conversationId: string;
        role: string;
        content: string;
        toolCalls?: unknown | null;
        groundingRefs?: unknown | null;
        tokenCount?: number;
        idempotencyKey?: string | null;
      };
    }): Promise<MessageRow>;
    findFirst(args: {
      where: {
        conversationId: string;
        idempotencyKey?: string;
      };
    }): Promise<MessageRow | null>;
    findMany(args: {
      where: { conversationId: string };
      orderBy?: Array<{ createdAt?: 'asc' | 'desc' } | { id?: 'asc' | 'desc' }>;
      cursor?: { id: string };
      take?: number;
      skip?: number;
    }): Promise<MessageRow[]>;
    count(args: { where: { conversationId: string } }): Promise<number>;
  };
  $transaction<T>(fn: (tx: ConversationPrismaClient) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Cursor encoding / decoding
// ---------------------------------------------------------------------------

interface CursorPayload {
  createdAt: string;
  id: string;
}

function encodeCursor(createdAt: Date, id: string): string {
  const payload: CursorPayload = { createdAt: createdAt.toISOString(), id };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function decodeCursor(cursor: string): CursorPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  } catch {
    throw new ConversationError('VALIDATION_FAILED', 'Invalid pagination cursor', 'cursor');
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as Record<string, unknown>).createdAt !== 'string' ||
    typeof (raw as Record<string, unknown>).id !== 'string'
  ) {
    throw new ConversationError('VALIDATION_FAILED', 'Malformed pagination cursor', 'cursor');
  }
  const { createdAt, id } = raw as CursorPayload;
  if (isNaN(Date.parse(createdAt))) {
    throw new ConversationError('VALIDATION_FAILED', 'Cursor contains invalid date', 'cursor');
  }
  return { createdAt, id };
}

// ---------------------------------------------------------------------------
// Ownership predicate helpers
// ---------------------------------------------------------------------------

function ownershipWhere(principal: Principal): { userId?: string | null; guestSessionId?: string | null } {
  if (principal.type === 'user') {
    return { userId: principal.userId };
  }
  return { guestSessionId: principal.guestSessionId };
}

// ---------------------------------------------------------------------------
// Row → domain mappers
// ---------------------------------------------------------------------------

function toConversationSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status as ConversationSummary['status'],
    resolvedSlots: (row.resolvedSlots as Record<string, unknown>) ?? {},
    tokenTotals: (row.tokenTotals as Record<string, number>) ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
  };
}

function toMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as ConversationMessage['role'],
    content: row.content,
    toolCalls: (row.toolCalls as unknown[] | null) ?? null,
    groundingRefs: (row.groundingRefs as unknown[] | null) ?? null,
    tokenCount: row.tokenCount,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// ConversationRepository
// ---------------------------------------------------------------------------

export class ConversationRepository implements ConversationRepositoryPort {
  constructor(private readonly db: ConversationPrismaClient) {}

  async createConversation(
    principal: Principal,
    input: CreateConversationInput,
  ): Promise<ConversationSummary> {
    const ownerData =
      principal.type === 'user'
        ? { userId: principal.userId, guestSessionId: null }
        : { userId: null, guestSessionId: principal.guestSessionId };

    const row = await this.db.conversation.create({
      data: {
        ...ownerData,
        title: input.title ?? null,
        status: 'active',
      },
    });

    return toConversationSummary(row);
  }

  async appendMessage(
    principal: Principal,
    conversationId: string,
    input: AppendMessageInput,
  ): Promise<ConversationMessage> {
    if (input.content.length > MAX_CONTENT_LENGTH) {
      throw new ConversationError(
        'CONTENT_TOO_LONG',
        `Message content exceeds ${MAX_CONTENT_LENGTH} characters`,
        'content',
      );
    }

    // Verify ownership — return NOT_FOUND if not owned (existence non-disclosure).
    const existing = await this.db.conversation.findFirst({
      where: { id: conversationId, ...ownershipWhere(principal) },
    });
    if (!existing) {
      throw new ConversationError('NOT_FOUND', 'Conversation not found');
    }

    // Idempotency: return existing message if same key already stored.
    if (input.idempotencyKey) {
      const dupe = await this.db.conversationMessage.findFirst({
        where: { conversationId, idempotencyKey: input.idempotencyKey },
      });
      if (dupe) return toMessage(dupe);
    }

    const redactedContent = redact(input.content);

    return this.db.$transaction(async (tx) => {
      let msgRow: MessageRow;
      try {
        msgRow = await tx.conversationMessage.create({
          data: {
            conversationId,
            role: input.role,
            content: redactedContent,
            toolCalls: input.toolCalls ?? null,
            groundingRefs: input.groundingRefs ?? null,
            tokenCount: input.tokenCount ?? 0,
            idempotencyKey: input.idempotencyKey ?? null,
          },
        });
      } catch (err) {
        // Catch Prisma P2002 unique violation on (conversation_id, idempotency_key).
        // This handles the narrow race between the pre-check and the insert.
        if (
          input.idempotencyKey &&
          err !== null &&
          typeof err === 'object' &&
          (err as Record<string, unknown>)['code'] === 'P2002'
        ) {
          const existing = await tx.conversationMessage.findFirst({
            where: { conversationId, idempotencyKey: input.idempotencyKey },
          });
          if (existing) return toMessage(existing);
        }
        throw err;
      }

      // Merge token count into tokenTotals[role] and update last_activity_at.
      const currentTotals = (existing.tokenTotals as Record<string, number>) ?? {};
      const roleKey = input.role;
      const updatedTotals: Record<string, number> = {
        ...currentTotals,
        [roleKey]: (currentTotals[roleKey] ?? 0) + (input.tokenCount ?? 0),
      };

      // Merge resolved_slots if provided.
      let updatedSlots = (existing.resolvedSlots as Record<string, unknown>) ?? {};
      if (input.resolvedSlots) {
        updatedSlots = { ...updatedSlots, ...input.resolvedSlots };
      }

      const now = new Date();
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          tokenTotals: updatedTotals,
          resolvedSlots: updatedSlots,
          lastActivityAt: now,
          updatedAt: now,
        },
      });

      return toMessage(msgRow);
    });
  }

  async getConversationWithMessages(
    principal: Principal,
    conversationId: string,
    options: PaginationOptions,
  ): Promise<ConversationWithMessages> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, ...ownershipWhere(principal) },
    });
    if (!conversation) {
      throw new ConversationError('NOT_FOUND', 'Conversation not found');
    }

    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    // Decode cursor if provided.
    let cursorId: string | undefined;
    if (options.cursor) {
      const decoded = decodeCursor(options.cursor);
      cursorId = decoded.id;
    }

    // Fetch one extra to determine if there's a next page.
    const rows = await this.db.conversationMessage.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      cursor: cursorId ? { id: cursorId } : undefined,
      take: limit + 1,
      skip: cursorId ? 1 : 0,
    });

    const hasNext = rows.length > limit;
    const messages = rows.slice(0, limit).map(toMessage);
    const lastMsg = messages[messages.length - 1];
    const nextCursor =
      hasNext && lastMsg ? encodeCursor(lastMsg.createdAt, lastMsg.id) : null;

    return {
      conversation: toConversationSummary(conversation),
      messages,
      nextCursor,
    };
  }

  async listConversations(
    principal: Principal,
    options: PaginationOptions,
  ): Promise<{ conversations: ConversationSummary[]; nextCursor: string | null }> {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    let cursorId: string | undefined;
    if (options.cursor) {
      const decoded = decodeCursor(options.cursor);
      cursorId = decoded.id;
    }

    const rows = await this.db.conversation.findMany({
      where: ownershipWhere(principal),
      orderBy: { lastActivityAt: 'desc' },
      cursor: cursorId ? { id: cursorId } : undefined,
      take: limit + 1,
      skip: cursorId ? 1 : 0,
    });

    const hasNext = rows.length > limit;
    const conversations = rows.slice(0, limit).map(toConversationSummary);
    const lastConv = conversations[conversations.length - 1];
    const nextCursor =
      hasNext && lastConv ? encodeCursor(lastConv.lastActivityAt, lastConv.id) : null;

    return { conversations, nextCursor };
  }

  async updateResolvedSlots(
    principal: Principal,
    conversationId: string,
    slots: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, ...ownershipWhere(principal) },
    });
    if (!conversation) {
      throw new ConversationError('NOT_FOUND', 'Conversation not found');
    }

    const current = (conversation.resolvedSlots as Record<string, unknown>) ?? {};
    const merged = { ...current, ...slots };

    const updated = await this.db.conversation.update({
      where: { id: conversationId },
      data: { resolvedSlots: merged, updatedAt: new Date() },
    });

    return (updated.resolvedSlots as Record<string, unknown>) ?? {};
  }

  async deleteConversation(principal: Principal, conversationId: string): Promise<void> {
    // Idempotent: if the conversation doesn't exist or isn't owned, return success.
    const result = await this.db.conversation.deleteMany({
      where: { id: conversationId, ...ownershipWhere(principal) },
    });
    // result.count === 0 means already absent — per AC9, this is success.
    void result;
  }

  async claimConversation(
    guestSessionId: string,
    userId: string,
    conversationId: string,
  ): Promise<void> {
    // Only guest-owned conversations can be claimed.
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId },
    });

    if (!conversation) {
      throw new ConversationError('NOT_FOUND', 'Conversation not found');
    }

    // Already owned by an authenticated user — cannot claim.
    if (conversation.userId !== null) {
      throw new ConversationError(
        'CLAIM_CONFLICT',
        'Conversation is already owned by an authenticated user',
      );
    }

    // Verify it's owned by the expected guest session.
    if (conversation.guestSessionId !== guestSessionId) {
      throw new ConversationError('NOT_FOUND', 'Conversation not found');
    }

    await this.db.conversation.update({
      where: { id: conversationId },
      data: { userId, guestSessionId: null, updatedAt: new Date() },
    });
  }
}
