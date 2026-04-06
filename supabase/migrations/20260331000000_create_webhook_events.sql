-- Migration: create webhook_events table
-- Entity:    E-WEBHOOK-EVENT (data-model-and-ownership §4)
-- Owner:     webhook-ingestion module
-- Purpose:   Durable idempotency record for inbound LoopMessage webhook deliveries.
--            Insert-once; UNIQUE on webhook_id enforces dedupe at the DB level
--            as a belt-and-suspenders guard alongside the application-level check.

create table webhook_events (
  id           uuid        primary key default gen_random_uuid(),
  webhook_id   text        not null unique,   -- LoopMessage webhook_id dedup key (VID-002)
  received_at  timestamptz not null default now(),
  processed_at timestamptz             -- set when continuation job is successfully enqueued
);

-- Fast lookup by webhook_id on every inbound request
create index webhook_events_webhook_id_idx on webhook_events (webhook_id);

comment on table  webhook_events                is 'Idempotency records for inbound LoopMessage webhook deliveries (E-WEBHOOK-EVENT)';
comment on column webhook_events.webhook_id     is 'LoopMessage webhook_id UUID — primary deduplication key';
comment on column webhook_events.received_at    is 'Timestamp when the webhook POST arrived';
comment on column webhook_events.processed_at   is 'Timestamp when the inbound continuation job was successfully enqueued; null until then';
