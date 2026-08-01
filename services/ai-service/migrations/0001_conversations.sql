-- Migration 0001: Conversation session store for AI assistant service (WO-057)
--
-- Changes:
--   1. Create conversations table with ownership columns and row-level constraint
--   2. Create conversation_messages table with ON DELETE CASCADE FK
--   3. Pagination index on (conversation_id, created_at, id)
--   4. Partial unique index on (conversation_id, idempotency_key) WHERE NOT NULL
--   5. Listing index on (user_id, last_activity_at DESC)
--   6. Lookup index on (guest_session_id)
--
-- Access constraint: Only the ai-service ConversationRepository may query
-- these tables. No other service should access conversations or conversation_messages.

-- ── Step 1: conversations ────────────────────────────────────────────────────

CREATE TABLE "conversations" (
  "id"               UUID          NOT NULL DEFAULT gen_random_uuid(),
  "user_id"          UUID          NULL,
  "guest_session_id" TEXT          NULL,
  "title"            TEXT          NULL,
  "status"           TEXT          NOT NULL DEFAULT 'active',
  "resolved_slots"   JSONB         NOT NULL DEFAULT '{}',
  "token_totals"     JSONB         NOT NULL DEFAULT '{}',
  "created_at"       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "updated_at"       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "last_activity_at" TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT "conversations_pkey" PRIMARY KEY ("id"),

  -- Exactly one of user_id or guest_session_id must be non-null.
  -- This prevents orphaned conversations and anonymous ownership ambiguity.
  CONSTRAINT "chk_conversations_principal"
    CHECK (
      ("user_id" IS NOT NULL AND "guest_session_id" IS NULL)
      OR
      ("user_id" IS NULL AND "guest_session_id" IS NOT NULL)
    )
);

-- ── Step 2: conversation_messages ────────────────────────────────────────────

CREATE TABLE "conversation_messages" (
  "id"               UUID          NOT NULL DEFAULT gen_random_uuid(),
  "conversation_id"  UUID          NOT NULL,
  "role"             TEXT          NOT NULL,
  "content"          TEXT          NOT NULL,
  "tool_calls"       JSONB         NULL,
  "grounding_refs"   JSONB         NULL,
  "token_count"      INTEGER       NOT NULL DEFAULT 0,
  "idempotency_key"  TEXT          NULL,
  "created_at"       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "fk_conversation_messages_conversation"
    FOREIGN KEY ("conversation_id")
    REFERENCES "conversations" ("id")
    ON DELETE CASCADE
);

-- ── Step 3: Pagination index (message history, stable composite cursor) ──────

CREATE INDEX "idx_conversation_messages_pagination"
  ON "conversation_messages" ("conversation_id", "created_at", "id");

-- ── Step 4: Partial unique index for idempotency keys ────────────────────────
-- WHERE clause allows multiple NULL idempotency_key values (messages without
-- idempotency keys) while preventing duplicate retries for keyed appends.

CREATE UNIQUE INDEX "uq_conversation_messages_idempotency"
  ON "conversation_messages" ("conversation_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- ── Step 5: Conversation listing index (authenticated users) ─────────────────

CREATE INDEX "idx_conversations_user_activity"
  ON "conversations" ("user_id", "last_activity_at" DESC)
  WHERE "user_id" IS NOT NULL;

-- ── Step 6: Guest session lookup index ───────────────────────────────────────

CREATE INDEX "idx_conversations_guest_session"
  ON "conversations" ("guest_session_id")
  WHERE "guest_session_id" IS NOT NULL;
