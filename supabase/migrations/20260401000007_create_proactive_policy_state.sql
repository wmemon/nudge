-- Migration: create proactive_policy_state table
-- Entity:    E-PROACTIVE-POLICY-STATE (data-model-and-ownership §4)
-- Owner:     proactive-policy module
-- Purpose:   Per-recipient scoreboard for ADR §13 proactive sending policy:
--              - Rolling 24h cap (≤ 8 proactive sends per rolling 24h window)
--              - Minimum spacing (≥ effective_spacing_minutes between sends)
--              - 7-day reply-rate adaptive backoff (< 30% reply rate → 1.5×
--                spacing multiplier, capped at 2880 min = 48h)
--            One row per recipient; upserted on every proactive send and every
--            inbound reply. Removed on account deletion via cascade.

create table proactive_policy_state (
  id                        uuid        primary key default gen_random_uuid(),
  recipient_id              uuid        not null unique references recipients (id) on delete cascade,

  -- Spacing enforcement (ADR §13: ≥ effective_spacing_minutes between proactive sends)
  last_proactive_sent_at    timestamptz,                    -- null until first proactive send
  effective_spacing_minutes integer     not null default 90 -- grows with backoff; floor = config default
                              check (effective_spacing_minutes between 1 and 2880),

  -- Rolling 24h cap (ADR §13: ≤ 8 proactive sends per rolling 24h)
  rolling_24h_count         integer     not null default 0
                              check (rolling_24h_count >= 0),
  rolling_24h_window_start  timestamptz not null default now(),

  -- 7-day reply-rate window (ADR §13: < 30% → 1.5× spacing backoff, cap 48h)
  proactive_count_7d        integer     not null default 0
                              check (proactive_count_7d >= 0),
  inbound_replies_7d        integer     not null default 0
                              check (inbound_replies_7d >= 0),
  window_7d_started_at      timestamptz not null default now(),

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- Recipient-scoped reads (DDC-003)
create index proactive_policy_state_recipient_id_idx
  on proactive_policy_state (recipient_id);

comment on table  proactive_policy_state                          is 'Per-recipient proactive sending policy state (E-PROACTIVE-POLICY-STATE; ADR §13)';
comment on column proactive_policy_state.recipient_id             is 'One row per recipient (UNIQUE); cascade-deleted with recipient (DDC-003)';
comment on column proactive_policy_state.last_proactive_sent_at  is 'UTC timestamp of the most recent proactive send; null before first send';
comment on column proactive_policy_state.effective_spacing_minutes is 'Current enforced minimum minutes between proactive sends; starts at 90, grows 1.5× on low reply rate, capped at 2880 (48h)';
comment on column proactive_policy_state.rolling_24h_count        is 'Number of proactive sends in the current 24h rolling window (resets when window_start + 24h elapses)';
comment on column proactive_policy_state.rolling_24h_window_start is 'UTC start of the current 24h rolling window; reset when the window expires';
comment on column proactive_policy_state.proactive_count_7d       is 'Proactive sends in the current 7-day window; denominator for reply-rate calculation';
comment on column proactive_policy_state.inbound_replies_7d       is 'Inbound messages received in the current 7-day window; numerator for reply-rate calculation';
comment on column proactive_policy_state.window_7d_started_at     is 'UTC start of the current 7-day reply-rate window; counters reset when window_start + 7d elapses';
