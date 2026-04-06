-- Migration: create outbound_send_intents table
-- Entity:    E-OUTBOUND-SEND-INTENT (data-model-and-ownership §4)
-- Owner:     outbound-messaging module
-- Purpose:   Idempotency and audit record for every externally visible outbound
--            send. Checked before each send attempt so retries never deliver
--            duplicate iMessages (AIC-003).

create table outbound_send_intents (
  id                 uuid        primary key default gen_random_uuid(),
  recipient_id       uuid        not null references recipients (id) on delete cascade,
  idempotency_key    text        not null unique, -- scoped to recipient_id + window_id + send_type
  status             text        not null default 'pending'
                                   check (status in ('pending', 'delivered', 'failed')),
  provider_message_id text,       -- LoopMessage message_id; set on successful delivery
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Fast idempotency lookup on every send attempt
create index outbound_send_intents_idempotency_key_idx on outbound_send_intents (idempotency_key);
-- Recipient-scoped queries (DDC-003)
create index outbound_send_intents_recipient_id_idx    on outbound_send_intents (recipient_id);

comment on table  outbound_send_intents                     is 'Idempotency and audit records for outbound iMessage sends (E-OUTBOUND-SEND-INTENT)';
comment on column outbound_send_intents.idempotency_key     is 'Unique key scoped to recipient_id + window_id + outbound_send_type';
comment on column outbound_send_intents.status              is 'pending → delivered on ACK; pending → failed on DLQ exhaustion';
comment on column outbound_send_intents.provider_message_id is 'LoopMessage message_id returned on successful send';
