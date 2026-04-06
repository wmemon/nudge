-- Migration: create export_jobs table
-- Entity:    E-EXPORT-JOB (data-model-and-ownership §4)
-- Owner:     user-rights-ops module
-- Purpose:   Tracks the state machine and SLA deadline for each export
--            fulfillment job (JOB-EXPORT-001). One row is created when the
--            worker picks up an export request after OTP verification
--            (API-RIGHTS-001). Concurrent duplicate requests for the same
--            recipient reuse the active BullMQ job (jobId = 'export:<recipientId>')
--            so duplicate rows are not expected under normal operation.
--            Removed on account deletion via cascade.
--
-- IMPORTANT: The companion export_artifacts table stores the S3 key for the
--            produced bundle. Slice 8 (account deletion) MUST read s3_key values
--            from export_artifacts BEFORE issuing Postgres deletes — the cascade
--            on recipient_id will drop both rows simultaneously, making S3 keys
--            unrecoverable if deletion order is wrong.

create table export_jobs (
  id               uuid        primary key default gen_random_uuid(),
  recipient_id     uuid        not null references recipients (id) on delete cascade,
  status           text        not null default 'queued'
                                 check (status in ('queued', 'building', 'delivered', 'failed')),
  correlation_id   text        not null,              -- propagated from original HTTP request (OAC-001/003)
  sla_deadline_at  timestamptz not null,              -- computed by application: EOD (23:59:59 ET) on the
                                                      -- third US business day (Mon–Fri) after request (ADR §14)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  delivered_at     timestamptz,                       -- set when status transitions to 'delivered'
  failed_at        timestamptz,                       -- set when status transitions to 'failed'
  failure_reason   text                               -- brief non-sensitive reason for DLQ runbook; never
                                                      -- message body content (OAC-002)
);

-- Deletion cleanup: look up all export jobs for a recipient (account deletion, DDC-003)
create index export_jobs_recipient_id_idx on export_jobs (recipient_id);

-- Future SLA monitoring: find jobs still in-progress past their deadline
create index export_jobs_status_sla_idx on export_jobs (status, sla_deadline_at);

comment on table  export_jobs                  is 'Export fulfillment job state machine and SLA tracking (E-EXPORT-JOB)';
comment on column export_jobs.recipient_id     is 'Recipient who requested the export; cascade-deleted with recipient (DDC-003)';
comment on column export_jobs.status           is 'Job state machine: queued → building → delivered | failed';
comment on column export_jobs.correlation_id   is 'Correlation id from the originating HTTP request for end-to-end traceability (OAC-001)';
comment on column export_jobs.sla_deadline_at  is 'SLA deadline: EOD 23:59:59 ET on the third US business day after request (ADR §14)';
comment on column export_jobs.delivered_at     is 'Set to now() when the presigned iMessage link is successfully delivered';
comment on column export_jobs.failed_at        is 'Set to now() when the job exhausts retries and moves to failed state';
comment on column export_jobs.failure_reason   is 'Non-sensitive failure summary for DLQ runbook diagnostics; no message bodies (OAC-002)';
