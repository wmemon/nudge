import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto'

// ── Constants (Q4.R4) ─────────────────────────────────────────────────────────

export const OTP_VALIDITY_MS  = 15 * 60 * 1000  // 15 minutes
export const MAX_OTP_ATTEMPTS = 5                // invalidate after 5 failed attempts
export const OTP_SEND_CAP     = 3               // max sends per recipient per rolling hour

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OtpSession {
  id:             string
  recipientId:    string
  codeHash:       string
  issuedAt:       Date
  expiresAt:      Date
  attemptCount:   number
  consumedAt:     Date | null
  invalidatedAt:  Date | null
}

/** Result of evaluating a verify attempt. No side effects — callers act on this. */
export type OtpVerifyOutcome =
  | 'ok'
  | 'wrong_code'
  | 'expired'
  | 'consumed'
  | 'invalidated'

// ── Code generation ───────────────────────────────────────────────────────────

/**
 * Generates a cryptographically random 6-digit OTP string.
 * crypto.randomInt is uniformly distributed — no modulo bias.
 */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

// ── Hashing ───────────────────────────────────────────────────────────────────

/**
 * Returns the SHA-256 hex digest of the OTP code.
 *
 * A 6-digit code has only 1 000 000 possible values. A brute-force attack
 * against the hash is moot because sessions expire after 15 minutes and are
 * invalidated after 5 failed attempts — the window is too narrow. SHA-256 is
 * sufficient; bcrypt would add a dependency for no security gain here.
 */
export function hashOtpCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

/**
 * Constant-time comparison of a submitted code against a stored hash.
 * Uses timingSafeEqual to prevent timing-based enumeration attacks.
 */
export function verifyOtpCode(code: string, storedHash: string): boolean {
  const submittedHash = hashOtpCode(code)
  // Both are SHA-256 hex strings — always 64 bytes — so lengths always match.
  return timingSafeEqual(Buffer.from(submittedHash), Buffer.from(storedHash))
}

// ── Rights session types ──────────────────────────────────────────────────────

export const RIGHTS_TOKEN_TTL_MS = 60 * 60 * 1000  // 1 hour

export interface RightsSession {
  id:          string
  tokenHash:   string
  recipientId: string
  canExport:   boolean
  canDelete:   boolean
  issuedAt:    Date
  expiresAt:   Date
  revokedAt:   Date | null
}

export type RightsCapability = 'export' | 'delete'

/**
 * Generates a cryptographically random opaque bearer token.
 * Returns a 64-character hex string (32 bytes of entropy).
 * The raw value is returned once to the caller and never persisted —
 * only its hash is stored in rights_sessions.
 */
export function generateRightsToken(): string {
  return randomBytes(32).toString('hex')
}

// ── Outcome evaluation ────────────────────────────────────────────────────────

/**
 * Evaluates a verify attempt against the current session state and submitted code.
 * Pure function — no database calls, no side effects.
 * Callers must act on the returned outcome (increment attempts, mark consumed, etc.).
 */
export function evaluateVerifyAttempt(session: OtpSession, code: string): OtpVerifyOutcome {
  if (session.attemptCount  >= MAX_OTP_ATTEMPTS) return 'invalidated'
  if (session.invalidatedAt !== null) return 'invalidated'
  if (session.consumedAt    !== null) return 'consumed'
  if (new Date() > session.expiresAt) return 'expired'
  return verifyOtpCode(code, session.codeHash) ? 'ok' : 'wrong_code'
}
