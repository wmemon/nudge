-- Migration: create usage_counters table
-- Entity:    E-USAGE-COUNTER (data-model-and-ownership §4)
-- Owner:     usage-metering module
-- Purpose:   Per-recipient freemium usage counters for soft-warning enforcement.
--            One row per (recipient_id, metric_type) pair; upserted on every
--            increment. No hard-block logic lives here — thresholds are config-
--            backed (Q1.R1); hard enforcement flip remains product-owned until
--            numeric caps are defined (resolved-architecture-intake §16-17).
--            Removed on account deletion via cascade (Q10.R1).

create table usage_counters (
  id           uuid        primary key default gen_random_uuid(),
  recipient_id uuid        not null references recipients (id) on delete cascade,
  metric_type  text        not null
                             check (metric_type in ('goals_set', 'checkins_completed')),
  count        integer     not null default 0
                             check (count >= 0),
  updated_at   timestamptz not null default now(),

  unique (recipient_id, metric_type)
);

-- Fast per-recipient reads (DDC-003) and cascade verification
create index usage_counters_recipient_id_idx
  on usage_counters (recipient_id);

comment on table  usage_counters             is 'Per-recipient freemium usage counters (E-USAGE-COUNTER; Q1.R1). Soft-warning only in MVP — hard enforcement off until product defines numeric caps.';
comment on column usage_counters.recipient_id is 'Internal recipient this counter belongs to (DDC-003); cascade-deleted with recipient (Q10.R1)';
comment on column usage_counters.metric_type  is 'Counter dimension: "goals_set" or "checkins_completed". Closed CHECK enum — adding a third type requires a migration.';
comment on column usage_counters.count        is 'Monotonically increasing lifetime count for this metric. Non-negative. Reset/period logic deferred to post-MVP (Q1.R1).';
comment on column usage_counters.updated_at   is 'Stamped on every upsert by the application layer (usage-metering module)';
