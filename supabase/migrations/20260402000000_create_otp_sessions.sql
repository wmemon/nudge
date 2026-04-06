-- Migration: create otp_sessions table
-- Entity:    E-OTP-SESSION (data-model-and-ownership §4)
-- Owner:     otp-verification module
-- Purpose:   One row per issued OTP code for export/delete verification flows
--            (API-OTP-001 / API-OTP-002). Tracks issuance, expiry, attempt
--            count, consumed and invalidated state. The plaintext code is never
--            stored — only its hash (code_hash). Per-recipient send-rate cap
--            (max 3 sends per rolling hour, Q4.R4) is enforced by querying
--            issued_at on this table. Removed on account deletion via cascade.

create table otp_sessions (
  id              uuid        primary key default gen_random_uuid(),
  recipient_id    uuid        not null references recipients (id) on delete cascade,
  code_hash       text        not null,                     -- hash of the plaintext 6-digit code; never raw digits
  issued_at       timestamptz not null default now(),
  expires_at      timestamptz not null,                     -- issued_at + 15 min (set by application, Q4.R4)
  attempt_count   integer     not null default 0
                                check (attempt_count >= 0), -- incremented on every verify attempt (good or bad)
  consumed_at     timestamptz,                              -- set on successful verify; non-null = session is spent
  invalidated_at  timestamptz                               -- set when attempt_count reaches 5; non-null = session is dead (Q4.R4)
);

-- Covers the per-recipient rolling-hour send-cap query:
--   SELECT COUNT(*) FROM otp_sessions
--   WHERE recipient_id = ? AND issued_at >= NOW() - INTERVAL '1 hour'
create index otp_sessions_recipient_issued_at_idx
  on otp_sessions (recipient_id, issued_at);

comment on table  otp_sessions               is 'Per-issued-code OTP session records for export/delete verification (E-OTP-SESSION; Q4.R4)';
comment on column otp_sessions.recipient_id  is 'Recipient this OTP was sent to; cascade-deleted with recipient (DDC-003)';
comment on column otp_sessions.code_hash     is 'Hash of the plaintext 6-digit OTP; plaintext is never persisted';
comment on column otp_sessions.issued_at     is 'UTC timestamp when this OTP was issued and sent to the recipient';
comment on column otp_sessions.expires_at    is 'UTC expiry of this OTP (issued_at + 15 min by default, Q4.R4)';
comment on column otp_sessions.attempt_count is 'Running count of verify attempts against this session; invalidated at 5 (Q4.R4)';
comment on column otp_sessions.consumed_at   is 'Set to now() when the correct code is submitted; non-null = session spent';
comment on column otp_sessions.invalidated_at is 'Set to now() when attempt_count reaches 5 without success (Q4.R4)';
