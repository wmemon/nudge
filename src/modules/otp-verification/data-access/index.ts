import type { SupabaseClient } from '../../../platform/db-supabase/index.js'
import { InternalError } from '../../../shared/errors/index.js'
import type { OtpSession, RightsSession } from '../domain/index.js'

// ── Row mapper ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toOtpSession(row: Record<string, any>): OtpSession {
  return {
    id:            row.id            as string,
    recipientId:   row.recipient_id  as string,
    codeHash:      row.code_hash     as string,
    issuedAt:      new Date(row.issued_at    as string),
    expiresAt:     new Date(row.expires_at   as string),
    attemptCount:  row.attempt_count as number,
    consumedAt:    row.consumed_at    ? new Date(row.consumed_at    as string) : null,
    invalidatedAt: row.invalidated_at ? new Date(row.invalidated_at as string) : null,
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * Inserts a new OTP session row.
 * expiresAt must be pre-computed by the caller (issued_at + OTP_VALIDITY_MS).
 * DDC-003: scoped to a single recipientId.
 */
export async function insertOtpSession(
  supabase: SupabaseClient,
  params: { recipientId: string; codeHash: string; expiresAt: Date },
): Promise<OtpSession> {
  const { data, error } = await supabase
    .from('otp_sessions')
    .insert({
      recipient_id: params.recipientId,
      code_hash:    params.codeHash,
      expires_at:   params.expiresAt.toISOString(),
    })
    .select('*')
    .single()

  if (error) throw new InternalError(`insertOtpSession failed: ${error.message}`)
  if (!data)  throw new InternalError('insertOtpSession returned no row')

  return toOtpSession(data)
}

/**
 * Returns the OTP session with the given id, or null if not found.
 * DDC-003: callers must not use this to enumerate sessions across recipients.
 */
export async function findOtpSessionById(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<OtpSession | null> {
  const { data, error } = await supabase
    .from('otp_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle()

  if (error) throw new InternalError(`findOtpSessionById failed: ${error.message}`)
  return data ? toOtpSession(data) : null
}

/**
 * Increments attempt_count by 1 and returns the updated session.
 * The caller passes the current session so we can compute newCount = current + 1
 * without a separate SELECT round-trip.
 * DDC-003: scoped to a single session id.
 */
export async function incrementAttemptAndFetch(
  supabase: SupabaseClient,
  session: OtpSession,
): Promise<OtpSession> {
  const newCount = session.attemptCount + 1

  const { data, error } = await supabase
    .from('otp_sessions')
    .update({ attempt_count: newCount })
    .eq('id', session.id)
    .select('*')
    .single()

  if (error) throw new InternalError(`incrementAttemptAndFetch failed: ${error.message}`)
  if (!data)  throw new InternalError('incrementAttemptAndFetch returned no row')

  return toOtpSession(data)
}

/**
 * Sets consumed_at = now() for the given session.
 * Called after a correct code is submitted. Idempotent.
 * DDC-003: scoped to a single session id.
 */
export async function markConsumed(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<void> {
  const { error } = await supabase
    .from('otp_sessions')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', sessionId)

  if (error) throw new InternalError(`markConsumed failed: ${error.message}`)
}

/**
 * Sets invalidated_at = now() for the given session.
 * Called when attempt_count reaches MAX_OTP_ATTEMPTS without success. Idempotent.
 * DDC-003: scoped to a single session id.
 */
export async function markInvalidated(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<void> {
  const { error } = await supabase
    .from('otp_sessions')
    .update({ invalidated_at: new Date().toISOString() })
    .eq('id', sessionId)

  if (error) throw new InternalError(`markInvalidated failed: ${error.message}`)
}

/**
 * Counts OTP sessions issued to the given recipient in the last rolling hour.
 * Used to enforce the per-recipient 3-sends-per-hour cap (Q4.R4).
 * DDC-003: scoped to a single recipientId.
 */
export async function countRecentSends(
  supabase: SupabaseClient,
  recipientId: string,
): Promise<number> {
  const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  const { count, error } = await supabase
    .from('otp_sessions')
    .select('*', { count: 'exact', head: true })
    .eq('recipient_id', recipientId)
    .gte('issued_at', windowStart)

  if (error) throw new InternalError(`countRecentSends failed: ${error.message}`)
  return count ?? 0
}

// ── Rights session queries ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRightsSession(row: Record<string, any>): RightsSession {
  return {
    id:          row.id           as string,
    tokenHash:   row.token_hash   as string,
    recipientId: row.recipient_id as string,
    canExport:   row.can_export   as boolean,
    canDelete:   row.can_delete   as boolean,
    issuedAt:    new Date(row.issued_at  as string),
    expiresAt:   new Date(row.expires_at as string),
    revokedAt:   row.revoked_at ? new Date(row.revoked_at as string) : null,
  }
}

/**
 * Inserts a new rights session row after successful OTP verification.
 * tokenHash is the SHA-256 hex of the raw bearer token — raw token is never stored.
 * DDC-003: scoped to a single recipientId.
 */
export async function insertRightsSession(
  supabase: SupabaseClient,
  params: {
    recipientId: string
    tokenHash:   string
    canExport:   boolean
    canDelete:   boolean
    expiresAt:   Date
  },
): Promise<RightsSession> {
  const { data, error } = await supabase
    .from('rights_sessions')
    .insert({
      recipient_id: params.recipientId,
      token_hash:   params.tokenHash,
      can_export:   params.canExport,
      can_delete:   params.canDelete,
      expires_at:   params.expiresAt.toISOString(),
    })
    .select('*')
    .single()

  if (error) throw new InternalError(`insertRightsSession failed: ${error.message}`)
  if (!data)  throw new InternalError('insertRightsSession returned no row')

  return toRightsSession(data)
}

/**
 * Looks up a rights session by the hash of the raw bearer token.
 * Returns null if not found.
 * DDC-003: token_hash has a UNIQUE index; always scopes to one session.
 */
export async function findRightsSessionByTokenHash(
  supabase: SupabaseClient,
  tokenHash: string,
): Promise<RightsSession | null> {
  const { data, error } = await supabase
    .from('rights_sessions')
    .select('*')
    .eq('token_hash', tokenHash)
    .maybeSingle()

  if (error) throw new InternalError(`findRightsSessionByTokenHash failed: ${error.message}`)
  return data ? toRightsSession(data) : null
}

/**
 * Revokes the rights session — sets revoked_at = now().
 * Called after a delete job is enqueued to prevent re-use. Idempotent.
 * DDC-003: scoped to a single session id.
 */
export async function revokeRightsSession(
  supabase: SupabaseClient,
  sessionId: string,
): Promise<void> {
  const { error } = await supabase
    .from('rights_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', sessionId)

  if (error) throw new InternalError(`revokeRightsSession failed: ${error.message}`)
}
