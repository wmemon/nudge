-- Migration: create schedules table
-- Entity:    E-SCHEDULE (data-model-and-ownership §4)
-- Owner:     goal-scheduling module
-- Purpose:   Persists schedule inputs (timezone, quiet hours, cadence) and the
--            derived next-run timestamp for each recipient's active check-in
--            schedule. One schedule row per recipient, upserted on change.
--            next_run_at is recomputed by a single code path on every edit
--            (ADR §4). Removed on account deletion via cascade.

create table schedules (
  id                  uuid        primary key default gen_random_uuid(),
  recipient_id        uuid        not null unique references recipients (id) on delete cascade,
  goal_id             uuid        not null references goals (id) on delete cascade,

  -- Schedule inputs (source of truth per ADR §4)
  check_in_time       text        not null,            -- "HH:MM" in local timezone, 24h (e.g. "07:00")
  timezone            text        not null default 'UTC', -- IANA timezone; defaulted until collected (Q3.R1)
  cadence             text        not null default 'daily'
                                    check (cadence in ('daily')),  -- expand post-MVP

  -- Quiet hours window in local timezone (hour 0–23)
  -- A start > end means the window spans midnight (e.g. 22–8 = 10 pm to 8 am)
  quiet_hours_start   integer     not null default 22
                                    check (quiet_hours_start between 0 and 23),
  quiet_hours_end     integer     not null default 8
                                    check (quiet_hours_end   between 0 and 23),

  -- Pause / snooze controls (Q3.2)
  paused              boolean     not null default false,
  snooze_until        timestamptz,                     -- null unless snoozed; cleared when elapsed

  -- Derived next execution instant (ADR §4); recomputed in one code path only
  next_run_at         timestamptz,                     -- null before first computation

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Due-job dispatch: find schedules whose next_run_at has passed
create index schedules_next_run_at_idx on schedules (next_run_at)
  where next_run_at is not null and paused = false;

comment on table  schedules                  is 'Check-in schedule inputs and derived next-run for each recipient (E-SCHEDULE)';
comment on column schedules.recipient_id     is 'One schedule per recipient (UNIQUE); scoped per DDC-003';
comment on column schedules.goal_id          is 'The active goal this schedule drives check-ins for';
comment on column schedules.check_in_time    is '"HH:MM" preferred check-in time in the recipient''s local timezone';
comment on column schedules.timezone         is 'IANA timezone string; defaults to UTC until collected during onboarding (Q3.R1)';
comment on column schedules.cadence          is 'Recurrence rule; only "daily" supported in MVP';
comment on column schedules.quiet_hours_start is 'Hour (0–23, local) when quiet period begins; start > end = spans midnight';
comment on column schedules.quiet_hours_end   is 'Hour (0–23, local) when quiet period ends';
comment on column schedules.paused           is 'True when check-ins are paused for this recipient (Q3.2)';
comment on column schedules.snooze_until     is 'Null unless snoozed; check-ins resume after this timestamp (Q3.2)';
comment on column schedules.next_run_at      is 'Derived next check-in instant (UTC); recomputed by one code path (ADR §4)';
