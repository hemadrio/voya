-- Safe fixture: CREATE TABLE (additive — no existing data at risk)

CREATE TABLE IF NOT EXISTS feature_flags (
  id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  flag_name   TEXT        NOT NULL UNIQUE,
  enabled     BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
