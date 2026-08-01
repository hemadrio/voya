-- Migration: 0018_assistant_cost_record
-- WO-107: Durable cost record for assistant model calls and booking attribution.
--
-- Design:
--   assistant_cost_record — one row per completed assistant model call.
--     conversation_id     — links to the conversation that generated this call.
--     model               — Anthropic model identifier (never truncated).
--     input_tokens        — actual input token count from the model response.
--     output_tokens       — actual output token count from the model response.
--     tool_call_count     — number of tool calls made during this turn.
--     cost_usd            — computed cost in USD from the versioned price table.
--     price_table_version — identifies which price table entry was used.
--     occurred_at         — wall-clock time of the model call.
--     purge_after         — occurred_at + 2 years; drives the retention sweep.
--
--   bookings.conversation_id — nullable column added so the attribution join
--     can link AI-assisted bookings to their originating conversation.
--     NULL for form-based (non-AI) bookings — these appear only in the
--     denominator of the cost-per-booking metric, never in attributed spend.
--
-- Security:
--   app_role has INSERT and SELECT only.  No UPDATE or DELETE — records are
--   immutable.  Purge is performed by a dedicated maintenance role.
--
-- All DDL is idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Add conversation_id to bookings (nullable — form-based bookings have none)
-- ---------------------------------------------------------------------------

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS conversation_id TEXT;

COMMENT ON COLUMN bookings.conversation_id IS
  'ID of the AI assistant conversation that initiated this booking, if any. '
  'NULL for form-based bookings. Used by the cost-attribution join in WO-107.';

CREATE INDEX IF NOT EXISTS idx_bookings_conversation_id
  ON bookings (conversation_id)
  WHERE conversation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Add confirmed_at to bookings (nullable — set when status reaches CONFIRMED)
-- ---------------------------------------------------------------------------

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

COMMENT ON COLUMN bookings.confirmed_at IS
  'Timestamp when this booking transitioned to CONFIRMED status. '
  'Set by the payment webhook handler. NULL until confirmed. Used by WO-107 '
  'attribution join.';

CREATE INDEX IF NOT EXISTS idx_bookings_confirmed_at
  ON bookings (confirmed_at)
  WHERE confirmed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Create assistant_cost_record table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS assistant_cost_record (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id     TEXT        NOT NULL,
  model               TEXT        NOT NULL,
  input_tokens        INTEGER     NOT NULL CHECK (input_tokens >= 0),
  output_tokens       INTEGER     NOT NULL CHECK (output_tokens >= 0),
  tool_call_count     INTEGER     NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0),
  cost_usd            NUMERIC(10, 6) NOT NULL CHECK (cost_usd >= 0),
  price_table_version TEXT        NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_after         TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE assistant_cost_record IS
  'PII-free, immutable record of each completed assistant model call. '
  'Contains only token counts, model identifier, conversation id, and derived '
  'cost. No prompt text, completion text, or traveler PII. WO-107.';

COMMENT ON COLUMN assistant_cost_record.cost_usd IS
  'Cost in USD computed from the versioned price table at the time of the call. '
  'Reproducible: recompute with the same price_table_version.';

COMMENT ON COLUMN assistant_cost_record.purge_after IS
  'Retention date = occurred_at + 2 years. The maintenance purge sweeps rows '
  'where purge_after < now() in batches.';

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_cost_record_conversation_id
  ON assistant_cost_record (conversation_id);

CREATE INDEX IF NOT EXISTS idx_cost_record_occurred_at
  ON assistant_cost_record (occurred_at);

CREATE INDEX IF NOT EXISTS idx_cost_record_purge_after
  ON assistant_cost_record (purge_after);

-- Composite index for attribution window query
CREATE INDEX IF NOT EXISTS idx_cost_record_conv_occurred
  ON assistant_cost_record (conversation_id, occurred_at);

-- ---------------------------------------------------------------------------
-- 4. Row-level security grants — app_role: INSERT + SELECT only
-- ---------------------------------------------------------------------------

-- These are conditional: only run if the role exists (it may not in test envs).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    GRANT INSERT, SELECT ON assistant_cost_record TO app_role;
    GRANT SELECT ON assistant_cost_record TO app_role;
  END IF;
END;
$$;
