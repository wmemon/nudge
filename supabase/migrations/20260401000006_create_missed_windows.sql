-- Migration: create missed_windows table
-- Entity:    E-MISSED-WINDOW (data-model-and-ownership §4)
-- Owner:     goal-scheduling module
-- Purpose:   Append-only record of check-in windows that were due but not
--            delivered (downtime, paused, quiet hours). Streak and accountability
--            logic accounts for missed windows — they are never backfilled as
--            successful sends (Q12.3). Removed on account deletion via cascade.

create table missed_windows (
  id            uuid        primary key default gen_random_uuid(),
  recipient_id  uuid        not null references recipients (id) on delete cascade,
  scheduled_at  timestamptz not null,                -- when the window was supposed to fire
  missed_at     timestamptz not null default now(),  -- when the miss was detected
  reason        text        not null
                              check (reason in ('downtime', 'paused', 'quiet_hours')),
  created_at    timestamptz not null default now()
);

-- One missed-window row per recipient + scheduled slot (DDC-001)
create unique index missed_windows_recipient_scheduled_at_idx
  on missed_windows (recipient_id, scheduled_at);

-- Recipient-scoped accountability queries (DDC-003)
create index missed_windows_recipient_id_idx on missed_windows (recipient_id);

comment on table  missed_windows              is 'Append-only record of missed check-in windows (E-MISSED-WINDOW)';
comment on column missed_windows.recipient_id is 'Recipient whose window was missed (DDC-003)';
comment on column missed_windows.scheduled_at is 'UTC timestamp when the check-in was originally due';
comment on column missed_windows.missed_at    is 'UTC timestamp when the miss was detected (job fired late or skipped)';
comment on column missed_windows.reason       is '"downtime" = worker unavailable; "paused" = schedule paused; "quiet_hours" = fell inside quiet window';
