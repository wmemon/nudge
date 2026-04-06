-- Migration: create goals table
-- Entity:    E-GOAL (data-model-and-ownership §4)
-- Owner:     goal-scheduling module
-- Purpose:   Append-only goal history for each recipient. At most one active
--            goal per recipient (Q3.1). Goal changes create a new row and mark
--            the prior goal inactive (deactivated_at set). Removed on account
--            deletion via cascade.

create table goals (
  id              uuid        primary key default gen_random_uuid(),
  recipient_id    uuid        not null references recipients (id) on delete cascade,
  text            text        not null,              -- goal statement captured from conversation
  active          boolean     not null default true, -- false when superseded by a new goal
  deactivated_at  timestamptz,                       -- null while active; set when superseded
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Enforce at most one active goal per recipient at the DB level (Q3.1).
-- Application must set active = false on the prior row before inserting a
-- replacement, or this constraint will raise a unique violation.
create unique index goals_one_active_per_recipient_idx
  on goals (recipient_id)
  where active = true;

-- Recipient-scoped queries (DDC-003)
create index goals_recipient_id_idx on goals (recipient_id);

comment on table  goals                is 'Goal records for each recipient; append-only (E-GOAL)';
comment on column goals.recipient_id   is 'Recipient this goal belongs to (DDC-003)';
comment on column goals.text           is 'Goal statement captured from the onboarding conversation';
comment on column goals.active         is 'True for the single current goal; false for superseded goals';
comment on column goals.deactivated_at is 'Set when this goal is superseded by a new goal; null while active';
