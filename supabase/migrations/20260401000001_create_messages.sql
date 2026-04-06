-- Migration: create messages table
-- Entity:    E-MESSAGE (data-model-and-ownership §4)
-- Owner:     conversation-accountability module
-- Purpose:   Durable record of every inbound and outbound message turn.
--            Retained until account deletion (Q6.1). Export is generated
--            from stored message rows. Inbound images: no S3 bytes stored;
--            has_image_attachment flag and optional provider ref only (Q6.3).

create table messages (
  id                   uuid        primary key default gen_random_uuid(),
  recipient_id         uuid        not null references recipients (id) on delete cascade,
  direction            text        not null check (direction in ('inbound', 'outbound')),
  body                 text        not null,
  has_image_attachment boolean     not null default false,
  provider_message_id  text,       -- optional provider ref for send idempotency correlation
  created_at           timestamptz not null default now()
);

-- Conversation history queries always filter + order by recipient and time
create index messages_recipient_id_created_at_idx on messages (recipient_id, created_at);

comment on table  messages                       is 'Inbound and outbound message records for accountability and export (E-MESSAGE)';
comment on column messages.recipient_id          is 'Internal recipient this message belongs to (DDC-003)';
comment on column messages.direction             is '"inbound" for messages from the user; "outbound" for AI replies';
comment on column messages.body                  is 'Message text content';
comment on column messages.has_image_attachment  is 'True when the inbound message included an image; no bytes stored (Q6.3)';
comment on column messages.provider_message_id   is 'LoopMessage message_id for outbound correlation; null for inbound';
