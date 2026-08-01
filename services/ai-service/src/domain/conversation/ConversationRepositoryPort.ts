/**
 * ConversationRepositoryPort — domain interface for conversation persistence (WO-057).
 *
 * All methods require a Principal; ownership is derived from the Principal only,
 * never from client-supplied body fields (OWASP A01 control).
 *
 * All methods return NOT_FOUND when the principal does not own the target row,
 * preventing existence disclosure to non-owners.
 */

// ---------------------------------------------------------------------------
// Principal — identifies the conversation owner
// ---------------------------------------------------------------------------

export type AuthPrincipal = { type: 'user'; userId: string };
export type GuestPrincipal = { type: 'guest'; guestSessionId: string };
export type Principal = AuthPrincipal | GuestPrincipal;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type ConversationStatus = 'active' | 'archived' | 'deleted';
export type MessageRole = 'user' | 'assistant' | 'tool';

/** Opaque cursor string — base64-encoded JSON with { createdAt, id }. */
export type Cursor = string & { readonly __cursor: unique symbol };

export interface ConversationSummary {
  id: string;
  title: string | null;
  status: ConversationStatus;
  resolvedSlots: Record<string, unknown>;
  tokenTotals: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  toolCalls: unknown[] | null;
  groundingRefs: unknown[] | null;
  tokenCount: number;
  createdAt: Date;
}

export interface ConversationWithMessages {
  conversation: ConversationSummary;
  messages: ConversationMessage[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateConversationInput {
  title?: string;
}

export interface AppendMessageInput {
  role: MessageRole;
  content: string;
  toolCalls?: unknown[] | null;
  groundingRefs?: unknown[] | null;
  tokenCount?: number;
  idempotencyKey?: string;
  /** Slot updates to merge into the conversation's resolved_slots. */
  resolvedSlots?: Record<string, unknown>;
}

export interface PaginationOptions {
  /** Opaque cursor from a previous response. */
  cursor?: string;
  /** Maximum messages/conversations per page. Capped at 100. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

export type ConversationErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'PERSISTENCE_ERROR'
  | 'CLAIM_CONFLICT'
  | 'CONTENT_TOO_LONG';

export class ConversationError extends Error {
  constructor(
    public readonly code: ConversationErrorCode,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'ConversationError';
  }
}

// ---------------------------------------------------------------------------
// Repository port
// ---------------------------------------------------------------------------

export interface ConversationRepositoryPort {
  /**
   * Create a new conversation owned by the given principal.
   */
  createConversation(
    principal: Principal,
    input: CreateConversationInput,
  ): Promise<ConversationSummary>;

  /**
   * Append a message to a conversation owned by the principal.
   *
   * If idempotencyKey is supplied and a message with that key already exists
   * on this conversation, the existing message is returned without a duplicate
   * insert (idempotent under client retries).
   *
   * The message insert, conversation token_totals update, last_activity_at
   * update, and resolved_slots merge are executed in a single transaction.
   *
   * Content is passed through PII redaction before persistence.
   */
  appendMessage(
    principal: Principal,
    conversationId: string,
    input: AppendMessageInput,
  ): Promise<ConversationMessage>;

  /**
   * Retrieve a conversation and its messages with cursor pagination.
   * Messages are ordered by (created_at ASC, id ASC).
   *
   * Returns NOT_FOUND when the conversation does not exist or is not owned
   * by the principal.
   */
  getConversationWithMessages(
    principal: Principal,
    conversationId: string,
    options: PaginationOptions,
  ): Promise<ConversationWithMessages>;

  /**
   * List conversations owned by the principal, ordered by last_activity_at DESC.
   */
  listConversations(
    principal: Principal,
    options: PaginationOptions,
  ): Promise<{ conversations: ConversationSummary[]; nextCursor: string | null }>;

  /**
   * Merge slot updates into the conversation's resolved_slots.
   * Returns the resulting merged slots object.
   */
  updateResolvedSlots(
    principal: Principal,
    conversationId: string,
    slots: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /**
   * Hard-delete a conversation and all its messages.
   * Idempotent: returns without error when the conversation is already absent.
   */
  deleteConversation(principal: Principal, conversationId: string): Promise<void>;

  /**
   * Move a guest conversation to an authenticated user.
   *
   * Atomically sets user_id and clears guest_session_id.
   * Throws CLAIM_CONFLICT when the conversation is already owned by a user.
   * Throws NOT_FOUND when the conversation doesn't exist or the guestSessionId
   * doesn't match.
   */
  claimConversation(
    guestSessionId: string,
    userId: string,
    conversationId: string,
  ): Promise<void>;
}
