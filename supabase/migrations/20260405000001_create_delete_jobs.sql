-- Migration: create delete_jobs table
-- Entity:    E-DELETE-JOB (data-model-and-ownership §4)
-- Owner:     user-rights-ops module
-- Purpose:   Tracks the state machine for each account-deletion saga
--            (JOB-DELETE-001). One row is created when the worker picks up a
--            deletion request after OTP verification (API-RIGHTS-002). The row
--            acts as the idempotency and DLQ anchor for the saga.
--
-- Completion semantics (no 'completed' status):
--   Deletion is considered complete when the recipient row is removed — that
--   DELETE cascades this row away simultaneously. "No delete_jobs row + no
--   recipient row" = deletion succeeded. Any BullMQ retry that arrives after
--   a successful deletion finds no recipient and exits immediately (step 1 of
--   the saga). A row persisting in 'executing' state with a stale updated_at
--   is the signal for the DLQ runbook that a saga is stuck.
--
-- State machine:
--   pending   → executing  (worker picks up the job)
--   executing → failed     (saga step threw; BullMQ will retry)
--   failed    → executing  (BullMQ retry started)
--   executing → [cascade]  (recipient deleted; row disappears — implicit completion)
--
-- Audit trail:
--   A structured Pino log event ('delete.job.completed') is emitted just before
--   the final DELETE so the audit record always exists even if the process
--   crashes during the physical deletion (OAC-003).

create table delete_jobs (
  id             uuid        primary key default gen_random_uuid(),
  recipient_id   uuid        not null references recipients (id) on delete cascade,
  status         text        not null default 'pending'
                               check (status in ('pending', 'executing', 'failed')),
  correlation_id text        not null,              -- propagated from originating HTTP request (OAC-001/003)
  failure_reason text,                              -- brief non-sensitive reason for DLQ runbook; never
                                                    -- message body content (OAC-002)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Per-recipient lookup: find an in-flight or failed delete job for a given recipient
create index delete_jobs_recipient_id_idx on delete_jobs (recipient_id);

-- DLQ detection: find jobs stuck in 'executing' with a stale updated_at
-- e.g.: SELECT * FROM delete_jobs WHERE status = 'executing' AND updated_at < now() - interval '1 hour';
create index delete_jobs_status_updated_at_idx on delete_jobs (status, updated_at);

comment on table  delete_jobs                is 'Account-deletion saga state machine and DLQ anchor (E-DELETE-JOB)';
comment on column delete_jobs.recipient_id   is 'Recipient being deleted; cascade-deleted with recipient when deletion succeeds (DDC-003)';
comment on column delete_jobs.status         is 'Saga state: pending → executing → [cascade] on success | failed on error. No completed status — see migration header.';
comment on column delete_jobs.correlation_id is 'Correlation id from the originating HTTP request for end-to-end traceability (OAC-001)';
comment on column delete_jobs.failure_reason is 'Non-sensitive failure summary for DLQ runbook diagnostics; no message bodies (OAC-002)';
comment on column delete_jobs.updated_at     is 'Updated on every status transition; use with status index to detect stuck sagas';
