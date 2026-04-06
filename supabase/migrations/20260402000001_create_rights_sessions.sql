-- Migration: create rights_sessions table
-- Entity:    E-RIGHTS-SESSION (data-model-and-ownership §4)
-- Owner:     otp-verification module (issuance); user-rights-ops module (consumption)
-- Purpose:   Short-lived server-side session granting verified export and/or
--            delete capability after OTP confirmation (API-OTP-002). The raw
--            opaque bearer token is never stored — only its hash (token_hash).
--            The bearer token is presented on API-RIGHTS-001 and API-RIGHTS-002
--            to prove verified intent before export/delete jobs are enqueued.
--            Removed on account deletion via cascade.

create table rights_sessions (
  id           uuid        primary key default gen_random_uuid(),
  token_hash   text        not null unique,  -- hash of the raw opaque bearer token; never raw token
  recipient_id uuid        not null references recipients (id) on delete cascade,
  can_export   boolean     not null default true,
  can_delete   boolean     not null default true,
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,         -- set by application (e.g. issued_at + 1 hour)
  revoked_at   timestamptz                   -- set to now() on explicit revocation; null = still valid
);

-- Recipient-scoped cleanup on account deletion (DDC-003)
create index rights_sessions_recipient_id_idx on rights_sessions (recipient_id);

comment on table  rights_sessions              is 'Short-lived verified capability sessions for export/delete rights (E-RIGHTS-SESSION)';
comment on column rights_sessions.token_hash   is 'Hash of the raw opaque bearer token; plaintext is returned once and never stored';
comment on column rights_sessions.recipient_id is 'Recipient this rights session was issued for; cascade-deleted with recipient (DDC-003)';
comment on column rights_sessions.can_export   is 'True when this session grants the export capability (API-RIGHTS-001)';
comment on column rights_sessions.can_delete   is 'True when this session grants the delete capability (API-RIGHTS-002)';
comment on column rights_sessions.issued_at    is 'UTC timestamp when the rights session was issued (after successful OTP verify)';
comment on column rights_sessions.expires_at   is 'UTC expiry of this rights session; set by application at issuance time';
comment on column rights_sessions.revoked_at   is 'Set to now() on explicit revocation (e.g. after account deletion is enqueued); null = still valid';
