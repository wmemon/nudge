-- Migration: create export_artifacts table
-- Entity:    E-EXPORT-ARTIFACT (data-model-and-ownership §4)
-- Owner:     user-rights-ops module
-- Purpose:   Records metadata for each export bundle uploaded to S3
--            (user export prefix per ADR §7, FPC-003). One artifact row is
--            created per successful export job. The actual bytes live in S3;
--            this table holds only the key and integrity metadata.
--            The presigned download URL is never stored here — it is generated
--            at delivery time and passed directly to LoopMessage (OAC-002).
--            Removed on account deletion via cascade.
--
-- IMPORTANT: Slice 8 (account deletion) MUST query s3_key from this table
--            and delete the corresponding S3 objects BEFORE issuing the
--            Postgres recipient delete. The cascade on recipient_id will drop
--            this row at the same time as the recipient row, making S3 keys
--            unrecoverable if the deletion order is wrong.

create table export_artifacts (
  id             uuid        primary key default gen_random_uuid(),
  export_job_id  uuid        not null references export_jobs (id) on delete cascade,
  recipient_id   uuid        not null references recipients (id) on delete cascade,
                                                    -- denormalised from export_jobs so account deletion can
                                                    -- find all S3 keys for a recipient in one query without
                                                    -- joining through export_jobs (Q10.R1, DDC-003)
  s3_key         text        not null,              -- full S3 key, e.g. exports/<recipientId>/<jobId>/export.json
  size_bytes     bigint,                            -- populated after upload; null if upload did not report size
  content_hash   text,                              -- sha256 hex of bundle JSON for integrity verification; nullable
  created_at     timestamptz not null default now()
);

-- Primary path for account deletion: find all S3 keys owned by a recipient
create index export_artifacts_recipient_id_idx on export_artifacts (recipient_id);

-- Look up the artifact for a given job (1:1 in MVP)
create index export_artifacts_export_job_id_idx on export_artifacts (export_job_id);

comment on table  export_artifacts               is 'S3 export bundle metadata for delivered export jobs (E-EXPORT-ARTIFACT)';
comment on column export_artifacts.export_job_id is 'The export job that produced this artifact; cascade-deleted with job';
comment on column export_artifacts.recipient_id  is 'Denorm: recipient who owns this artifact; used by account deletion to locate S3 keys before cascade (DDC-003, Q10.R1)';
comment on column export_artifacts.s3_key        is 'Full S3 object key for the export bundle; used to delete the object on account deletion';
comment on column export_artifacts.size_bytes    is 'Size of the uploaded bundle in bytes; null if not reported by S3';
comment on column export_artifacts.content_hash  is 'SHA-256 hex digest of the bundle JSON for integrity verification; nullable';
