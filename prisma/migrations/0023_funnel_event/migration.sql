-- Migration: 0023_funnel_event
-- WO-106: Pseudonymised conversion funnel event table.
--
-- Design:
--   - append-only: app_role has INSERT + SELECT only; no UPDATE or DELETE.
--   - purge_after: populated at insert time (occurredAt + retention days).
--   - attributes: JSONB for bounded primitive key-value pairs.
--   - No PII columns: pseudonymous_actor_id is HMAC-SHA256, never raw userId.
--
-- Indexes:
--   (event_type, occurred_at) — event-type time-series queries
--   (pseudonymous_actor_id, occurred_at) — cohort join queries
--   (conversation_id) — assistant attribution
--   (purge_after) — purge sweep job
--   (itinerary_id) — multi-category attachment
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS funnel_event (
    id                     UUID        NOT NULL DEFAULT gen_random_uuid(),
    schema_version         INTEGER     NOT NULL DEFAULT 1,
    event_type             TEXT        NOT NULL,
    occurred_at            TIMESTAMPTZ NOT NULL,
    correlation_id         TEXT        NOT NULL,
    pseudonymous_actor_id  TEXT        NOT NULL,
    session_id             TEXT        NOT NULL,
    conversation_id        TEXT,
    itinerary_id           TEXT,
    booking_id             TEXT,
    category               TEXT        NOT NULL,
    attributes             JSONB       NOT NULL DEFAULT '{}',
    purge_after            TIMESTAMPTZ NOT NULL,

    CONSTRAINT pk_funnel_event PRIMARY KEY (id)
);

-- Indexes for time-series and cohort queries
CREATE INDEX IF NOT EXISTS idx_funnel_event_type_occurred_at
    ON funnel_event (event_type, occurred_at);

CREATE INDEX IF NOT EXISTS idx_funnel_event_actor_occurred_at
    ON funnel_event (pseudonymous_actor_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_funnel_event_conversation_id
    ON funnel_event (conversation_id)
    WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_funnel_event_itinerary_id
    ON funnel_event (itinerary_id)
    WHERE itinerary_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_funnel_event_purge_after
    ON funnel_event (purge_after);

-- Append-only enforcement: revoke UPDATE and DELETE from the application role.
-- INSERT + SELECT only so the funnel store cannot be used for mutations.
-- NOTE: replace 'app_role' with the actual Postgres role name for this environment.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
        REVOKE UPDATE, DELETE ON TABLE funnel_event FROM app_role;
        GRANT INSERT, SELECT ON TABLE funnel_event TO app_role;
    END IF;
END $$;
