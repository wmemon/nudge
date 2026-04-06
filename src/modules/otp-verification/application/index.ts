import { getSupabaseClient } from '../../../platform/db-supabase/index.js'
import { sendMessage } from '../../../platform/loopmessage-adapter/index.js'
import { verifyCaptcha } from '../../../platform/turnstile-verify/index.js'
import { findRecipientByHandle } from '../../identity-recipient/index.js'
import { createLogger } from '../../../platform/observability/index.js'
import { ValidationError, UnauthorizedError, TooManyRequestsError, InternalError } from '../../../shared/errors/index.js'
import {
  generateOtpCode,
  hashOtpCode,
  evaluateVerifyAttempt,
  generateRightsToken,
  OTP_VALIDITY_MS,
  MAX_OTP_ATTEMPTS,
  OTP_SEND_CAP,
  RIGHTS_TOKEN_TTL_MS,
} from '../domain/index.js'
import {
  insertOtpSession,
  findOtpSessionById,
  findRightsSessionByTokenHash,
  incrementAttemptAndFetch,
  markConsumed,
  markInvalidated,
  countRecentSends,
  insertRightsSession,
  revokeRightsSession,
} from '../data-access/index.js'

const log = createLogger({ module: 'otp-verification' })

// ── Request OTP ───────────────────────────────────────────────────────────────

export interface RequestOtpResult {
  /** Session id to pass to verifyOtp. Null when recipient is unknown (non-enumeration). */
  sessionId: string | null
}

/**
 * Handles an OTP request (API-OTP-001).
 *
 * Flow:
 *   1. Verify Turnstile token — 400 on failure
 *   2. Look up recipient by handle — unknown recipient returns generic success (non-enumeration, SPC-004)
 *   3. Enforce per-recipient 3-sends-per-hour cap — 429 when exceeded (Q4.R4)
 *   4. Generate + hash code, insert otp_sessions row
 *   5. Send OTP via LoopMessage — code is used here and never logged (OAC-002)
 *   6. Return { sessionId }
 *
 * If sendMessage fails after the session is inserted, the session expires unused
 * and the user can request again. No rollback needed.
 */
export async function requestOtp(params: {
  recipientHandle: string
  turnstileToken:  string
  correlationId:   string
}): Promise<RequestOtpResult> {
  const supabase = getSupabaseClient()

  // Step 1: Turnstile verification
  const captcha = await verifyCaptcha(params.turnstileToken)
  if (!captcha.success) {
    throw new ValidationError([{ message: 'Bot verification failed' }])
  }

  // Step 2: Recipient lookup — unknown = non-enumerating generic response (SPC-004, Q4.R2)
  const recipient = await findRecipientByHandle(params.recipientHandle)
  if (!recipient) {
    log.debug({ event: 'otp.request.unknown_recipient', correlationId: params.correlationId })
    return { sessionId: null }
  }

  // Step 3: Per-recipient send cap (Q4.R4)
  const recentSends = await countRecentSends(supabase, recipient.id)
  if (recentSends >= OTP_SEND_CAP) {
    throw new TooManyRequestsError('OTP send limit reached — please try again later')
  }

  // Step 4: Generate code, hash it, persist session
  const code      = generateOtpCode()
  const codeHash  = hashOtpCode(code)
  const expiresAt = new Date(Date.now() + OTP_VALIDITY_MS)
  const session   = await insertOtpSession(supabase, { recipientId: recipient.id, codeHash, expiresAt })

  // Step 5: Send OTP via LoopMessage — code used here only, never logged
  try {
    await sendMessage(recipient.handle, `Your Nudge verification code is: ${code}`)
  } catch (err) {
    // Session exists but message failed — user can request again; orphan expires naturally
    log.error({ event: 'otp.request.send_failed', correlationId: params.correlationId, sessionId: session.id, err })
    throw new InternalError('Failed to send verification code — please try again')
  }

  log.info({ event: 'otp.request.sent', correlationId: params.correlationId, sessionId: session.id })
  return { sessionId: session.id }
}

// ── Verify OTP ────────────────────────────────────────────────────────────────

export interface VerifyOtpResult {
  /** Raw opaque bearer token — returned once, never stored plain. */
  token:     string
  /** Expiry hint for UX — server enforces TTL independently. */
  expiresAt: Date
}

/**
 * Handles an OTP verification attempt (API-OTP-002).
 *
 * Flow:
 *   1. Load session — 401 if not found
 *   2. Evaluate attempt (expiry / consumed / invalidated / code match)
 *   3. On wrong_code: increment attempt count; invalidate if >= MAX_OTP_ATTEMPTS
 *   4. On ok: mark consumed, issue rights session
 *   5. Return { token, expiresAt }
 */
export async function verifyOtp(params: {
  sessionId:     string
  code:          string
  correlationId: string
}): Promise<VerifyOtpResult> {
  const supabase = getSupabaseClient()

  // Step 1: Load session
  const session = await findOtpSessionById(supabase, params.sessionId)
  if (!session) {
    throw new UnauthorizedError('Invalid or expired session')
  }

  // Step 2: Evaluate
  const outcome = evaluateVerifyAttempt(session, params.code)

  if (outcome === 'expired') {
    throw new UnauthorizedError('Verification code has expired')
  }
  if (outcome === 'consumed') {
    throw new UnauthorizedError('Verification code has already been used')
  }
  if (outcome === 'invalidated') {
    throw new UnauthorizedError('Verification code has been invalidated due to too many failed attempts')
  }

  // Step 3: Wrong code — increment and potentially invalidate
  if (outcome === 'wrong_code') {
    const updated = await incrementAttemptAndFetch(supabase, session)
    if (updated.attemptCount >= MAX_OTP_ATTEMPTS) {
      await markInvalidated(supabase, session.id)
      log.info({ event: 'otp.verify.invalidated', correlationId: params.correlationId, sessionId: session.id })
    }
    throw new UnauthorizedError('Invalid verification code')
  }

  // Step 4: Correct — mark consumed and issue rights session
  await markConsumed(supabase, session.id)

  const rawToken    = generateRightsToken()
  const tokenHash   = hashOtpCode(rawToken)
  const expiresAt   = new Date(Date.now() + RIGHTS_TOKEN_TTL_MS)
  await insertRightsSession(supabase, {
    recipientId: session.recipientId,
    tokenHash,
    canExport:   true,
    canDelete:   true,
    expiresAt,
  })

  log.info({ event: 'otp.verify.success', correlationId: params.correlationId, sessionId: session.id })

  return { token: rawToken, expiresAt }
}

// ── Verify rights token (called by user-rights-ops) ──────────────────────────

export interface VerifiedRights {
  recipientId: string
  sessionId:   string
}

/**
 * Validates a raw bearer token and checks it has the required capability.
 * Throws UnauthorizedError on any failure — callers surface this as 401.
 *
 * This is the only cross-module entry point for rights validation (SPC-004).
 */
export async function verifyRightsToken(
  rawToken:   string,
  capability: 'export' | 'delete',
): Promise<VerifiedRights> {
  const supabase  = getSupabaseClient()
  const tokenHash = hashOtpCode(rawToken)
  const rights    = await findRightsSessionByTokenHash(supabase, tokenHash)

  if (!rights) {
    throw new UnauthorizedError('Invalid or expired token')
  }
  if (rights.revokedAt !== null) {
    throw new UnauthorizedError('Token has been revoked')
  }
  if (new Date() > rights.expiresAt) {
    throw new UnauthorizedError('Token has expired')
  }
  if (capability === 'export' && !rights.canExport) {
    throw new UnauthorizedError('Token does not grant export capability')
  }
  if (capability === 'delete' && !rights.canDelete) {
    throw new UnauthorizedError('Token does not grant delete capability')
  }

  return { recipientId: rights.recipientId, sessionId: rights.id }
}

// ── Revoke rights session (called by user-rights-ops after delete enqueue) ────

/**
 * Revokes a rights session by its id.
 * Called by user-rights-ops after a delete job is enqueued to prevent re-use.
 */
export async function revokeSession(sessionId: string): Promise<void> {
  const supabase = getSupabaseClient()
  await revokeRightsSession(supabase, sessionId)
}
