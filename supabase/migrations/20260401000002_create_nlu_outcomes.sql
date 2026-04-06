-- Migration: create nlu_outcomes table
-- Entity:    E-NLU-OUTCOME (data-model-and-ownership §4)
-- Owner:     conversation-accountability module
-- Purpose:   Structured accountability/NLU facts derived from the LLM path.
--            Immutable fact after write. Affects streak logic.
--            Multiple outcomes per message are allowed.

create table nlu_outcomes (
  id           uuid    primary key default gen_random_uuid(),
  recipient_id uuid    not null references recipients (id) on delete cascade,
  message_id   uuid    not null references messages   (id) on delete cascade,
  outcome_type text    not null,   -- e.g. 'accountability_check'
  classification text  not null,   -- e.g. 'done', 'not_done', 'unclear'
  confidence   numeric,            -- optional; null when model does not provide
  created_at   timestamptz not null default now()
);

-- Streak and accountability queries filter by recipient
create index nlu_outcomes_recipient_id_idx on nlu_outcomes (recipient_id);
-- Join from message → outcomes
create index nlu_outcomes_message_id_idx   on nlu_outcomes (message_id);

comment on table  nlu_outcomes              is 'Structured NLU/accountability facts from the LLM path (E-NLU-OUTCOME)';
comment on column nlu_outcomes.recipient_id is 'Recipient this outcome is scoped to (DDC-003)';
comment on column nlu_outcomes.message_id   is 'Message turn this outcome was derived from';
comment on column nlu_outcomes.outcome_type is 'Classification category, e.g. "accountability_check"';
comment on column nlu_outcomes.classification is 'Outcome value, e.g. "done", "not_done", "unclear"';
comment on column nlu_outcomes.confidence   is 'Optional model confidence score; null when not provided';
