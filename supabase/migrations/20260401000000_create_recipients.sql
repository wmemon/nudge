-- Migration: create recipients table
-- Entity:    E-RECIPIENT (data-model-and-ownership §4)
-- Owner:     identity-recipient module
-- Purpose:   Canonical identity record for every LoopMessage contact the app
--            has seen. Created on first qualifying inbound; updated through
--            conversation and maintenance jobs; deleted by account deletion job.

create table recipients (
  id                  uuid        primary key default gen_random_uuid(),
  handle              text        not null unique,  -- E.164 phone or iCloud email (LoopMessage "contact")
  first_seen_at       timestamptz not null default now(),
  onboarding_complete boolean     not null default false, -- true when first goal exists (Q3.R2)
  quiet_hours_tz      text,                         -- IANA timezone; null until set
  globally_paused     boolean     not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Fast upsert and lookup by handle on every inbound event
create index recipients_handle_idx on recipients (handle);

comment on table  recipients                    is 'Canonical identity records for LoopMessage contacts (E-RECIPIENT)';
comment on column recipients.handle             is 'LoopMessage recipient identifier — E.164 phone or iCloud email';
comment on column recipients.first_seen_at      is 'Timestamp of the first qualifying inbound event for this handle';
comment on column recipients.onboarding_complete is 'True once the recipient has an active goal (Q3.R2)';
comment on column recipients.quiet_hours_tz     is 'IANA timezone for quiet-hours enforcement; null until explicitly set';
comment on column recipients.globally_paused    is 'True when all automated outbound is paused for this recipient';
comment on column recipients.updated_at         is 'Updated by application layer whenever recipient fields change';
