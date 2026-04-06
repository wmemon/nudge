-- E-OPERATIONAL-TOGGLE: feature flag table for dynamic toggle control.
-- Env var overrides always win (DPC-001); this table is the DB layer of the hybrid model (ADR §8).

CREATE TABLE operational_toggles (
  key        TEXT        PRIMARY KEY,
  enabled    BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed known toggles defaulting to false (env overrides activate them per environment)
INSERT INTO operational_toggles (key, enabled) VALUES
  ('LLM_CALLS_ENABLED',           false),
  ('PROACTIVE_SENDS_ENABLED',      false),
  ('RIGHTS_ENDPOINTS_ENABLED',     false),
  ('ENFORCE_OUTBOUND_ALLOWLIST',   false);
