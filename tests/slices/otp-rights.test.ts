import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  ValidationError,
  UnauthorizedError,
  TooManyRequestsError,
  ServiceUnavailableError,
} from '../../src/shared/errors/index.js'

// ── Mocks (hoisted before imports) ────────────────────────────────────────────

vi.mock('../../src/modules/otp-verification/index.js', () => ({
  requestOtp: vi.fn(),
  verifyOtp:  vi.fn(),
}))

vi.mock('../../src/modules/user-rights-ops/index.js', () => ({
  enqueueExport: vi.fn(),
  enqueueDelete: vi.fn(),
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

const { requestOtp, verifyOtp } = await import('../../src/modules/otp-verification/index.js')
const { enqueueExport, enqueueDelete } = await import('../../src/modules/user-rights-ops/index.js')
const { createApp } = await import('../../src/app/index.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_HANDLE      = '+13231112233'
const VALID_TURNSTILE   = 'valid-turnstile-token'
const VALID_SESSION_ID  = '00000000-0000-0000-0000-000000000001'
const VALID_OTP_CODE    = '123456'
const VALID_BEARER      = 'a'.repeat(64)
const EXPIRES_AT        = new Date(Date.now() + 60 * 60 * 1000)

// ── POST /utility/otp/request (API-OTP-001) ───────────────────────────────────

describe('POST /utility/otp/request (API-OTP-001)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createApp()
  })

  afterEach(async () => {
    await app.close()
    vi.resetAllMocks()
  })

  // ── Test 1: happy path — known recipient ──────────────────────────────────

  it('returns 200 with sessionId for a known recipient', async () => {
    vi.mocked(requestOtp).mockResolvedValue({ sessionId: VALID_SESSION_ID })

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/request',
      payload: { handle: VALID_HANDLE, turnstileToken: VALID_TURNSTILE },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', sessionId: VALID_SESSION_ID })
    expect(vi.mocked(requestOtp)).toHaveBeenCalledOnce()
  })

  // ── Test 2: unknown recipient — non-enumeration (SPC-004) ─────────────────

  it('returns 200 with sessionId: null for an unknown recipient (non-enumeration, SPC-004)', async () => {
    vi.mocked(requestOtp).mockResolvedValue({ sessionId: null })

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/request',
      payload: { handle: VALID_HANDLE, turnstileToken: VALID_TURNSTILE },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', sessionId: null })
  })

  // ── Test 3: Turnstile verification fails ──────────────────────────────────

  it('returns 400 when Turnstile verification fails', async () => {
    vi.mocked(requestOtp).mockRejectedValue(
      new ValidationError([{ message: 'Bot verification failed' }]),
    )

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/request',
      payload: { handle: VALID_HANDLE, turnstileToken: 'bad-token' },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
  })

  // ── Test 4: missing handle ────────────────────────────────────────────────

  it('returns 400 when handle is missing (VID-001)', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/request',
      payload: { turnstileToken: VALID_TURNSTILE },
    })

    expect(res.statusCode).toBe(400)
    expect(vi.mocked(requestOtp)).not.toHaveBeenCalled()
  })

  // ── Test 5: invalid E.164 format ──────────────────────────────────────────

  it('returns 400 when handle is not a valid E.164 number (VID-001)', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/request',
      payload: { handle: 'not-a-phone', turnstileToken: VALID_TURNSTILE },
    })

    expect(res.statusCode).toBe(400)
    expect(vi.mocked(requestOtp)).not.toHaveBeenCalled()
  })

  // ── Test 6: missing turnstileToken ───────────────────────────────────────

  it('returns 400 when turnstileToken is missing (VID-001)', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/request',
      payload: { handle: VALID_HANDLE },
    })

    expect(res.statusCode).toBe(400)
    expect(vi.mocked(requestOtp)).not.toHaveBeenCalled()
  })

  // ── Test 7: send cap exceeded (Q4.R4) ────────────────────────────────────

  it('returns 429 when per-recipient OTP send cap is exceeded (Q4.R4)', async () => {
    vi.mocked(requestOtp).mockRejectedValue(
      new TooManyRequestsError('OTP send limit reached — please try again later'),
    )

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/request',
      payload: { handle: VALID_HANDLE, turnstileToken: VALID_TURNSTILE },
    })

    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ error: { code: 'TOO_MANY_REQUESTS' } })
  })
})

// ── POST /utility/otp/verify (API-OTP-002) ────────────────────────────────────

describe('POST /utility/otp/verify (API-OTP-002)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createApp()
  })

  afterEach(async () => {
    await app.close()
    vi.resetAllMocks()
  })

  // ── Test 1: happy path ────────────────────────────────────────────────────

  it('returns 200 with token and expiresAt on correct code', async () => {
    vi.mocked(verifyOtp).mockResolvedValue({ token: VALID_BEARER, expiresAt: EXPIRES_AT })

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/verify',
      payload: { sessionId: VALID_SESSION_ID, code: VALID_OTP_CODE },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      token:     VALID_BEARER,
      expiresAt: EXPIRES_AT.toISOString(),
    })
  })

  // ── Test 2: wrong code ────────────────────────────────────────────────────

  it('returns 401 on wrong OTP code', async () => {
    vi.mocked(verifyOtp).mockRejectedValue(new UnauthorizedError('Invalid verification code'))

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/verify',
      payload: { sessionId: VALID_SESSION_ID, code: '000000' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
  })

  // ── Test 3: session not found ─────────────────────────────────────────────

  it('returns 401 when session is not found', async () => {
    vi.mocked(verifyOtp).mockRejectedValue(new UnauthorizedError('Invalid or expired session'))

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/verify',
      payload: { sessionId: VALID_SESSION_ID, code: VALID_OTP_CODE },
    })

    expect(res.statusCode).toBe(401)
  })

  // ── Test 4: expired session ───────────────────────────────────────────────

  it('returns 401 when OTP session has expired', async () => {
    vi.mocked(verifyOtp).mockRejectedValue(new UnauthorizedError('Verification code has expired'))

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/verify',
      payload: { sessionId: VALID_SESSION_ID, code: VALID_OTP_CODE },
    })

    expect(res.statusCode).toBe(401)
  })

  // ── Test 5: already consumed ──────────────────────────────────────────────

  it('returns 401 when OTP code has already been used', async () => {
    vi.mocked(verifyOtp).mockRejectedValue(
      new UnauthorizedError('Verification code has already been used'),
    )

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/verify',
      payload: { sessionId: VALID_SESSION_ID, code: VALID_OTP_CODE },
    })

    expect(res.statusCode).toBe(401)
  })

  // ── Test 6: invalidated after too many attempts ───────────────────────────

  it('returns 401 when session is invalidated due to too many failed attempts', async () => {
    vi.mocked(verifyOtp).mockRejectedValue(
      new UnauthorizedError('Verification code has been invalidated due to too many failed attempts'),
    )

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/verify',
      payload: { sessionId: VALID_SESSION_ID, code: VALID_OTP_CODE },
    })

    expect(res.statusCode).toBe(401)
  })

  // ── Test 7: missing sessionId ─────────────────────────────────────────────

  it('returns 400 when sessionId is missing (VID-001)', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/verify',
      payload: { code: VALID_OTP_CODE },
    })

    expect(res.statusCode).toBe(400)
    expect(vi.mocked(verifyOtp)).not.toHaveBeenCalled()
  })

  // ── Test 8: invalid code format ───────────────────────────────────────────

  it('returns 400 when code is not 6 digits (VID-001)', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/verify',
      payload: { sessionId: VALID_SESSION_ID, code: '12345' }, // 5 digits
    })

    expect(res.statusCode).toBe(400)
    expect(vi.mocked(verifyOtp)).not.toHaveBeenCalled()
  })

  // ── Test 9: sessionId not a UUID ──────────────────────────────────────────

  it('returns 400 when sessionId is not a UUID (VID-001)', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/utility/otp/verify',
      payload: { sessionId: 'not-a-uuid', code: VALID_OTP_CODE },
    })

    expect(res.statusCode).toBe(400)
    expect(vi.mocked(verifyOtp)).not.toHaveBeenCalled()
  })
})

// ── POST /utility/rights/export (API-RIGHTS-001) ──────────────────────────────

describe('POST /utility/rights/export (API-RIGHTS-001)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createApp()
  })

  afterEach(async () => {
    await app.close()
    vi.resetAllMocks()
  })

  // ── Test 1: happy path ────────────────────────────────────────────────────

  it('returns 202 with referenceId on valid export token', async () => {
    vi.mocked(enqueueExport).mockResolvedValue({ referenceId: 'export:recipient-uuid' })

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/rights/export',
      headers: { authorization: `Bearer ${VALID_BEARER}` },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ referenceId: 'export:recipient-uuid' })
    expect(vi.mocked(enqueueExport)).toHaveBeenCalledOnce()
  })

  // ── Test 2: missing Authorization header ──────────────────────────────────

  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url:    '/utility/rights/export',
    })

    expect(res.statusCode).toBe(401)
    expect(vi.mocked(enqueueExport)).not.toHaveBeenCalled()
  })

  // ── Test 3: malformed Authorization header ────────────────────────────────

  it('returns 401 when Authorization header is not Bearer scheme', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/utility/rights/export',
      headers: { authorization: 'Basic sometoken' },
    })

    expect(res.statusCode).toBe(401)
    expect(vi.mocked(enqueueExport)).not.toHaveBeenCalled()
  })

  // ── Test 4: invalid / expired token ──────────────────────────────────────

  it('returns 401 when token is invalid or expired', async () => {
    vi.mocked(enqueueExport).mockRejectedValue(new UnauthorizedError('Invalid or expired token'))

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/rights/export',
      headers: { authorization: `Bearer ${VALID_BEARER}` },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
  })

  // ── Test 5: token lacks export capability ────────────────────────────────

  it('returns 401 when token does not grant export capability', async () => {
    vi.mocked(enqueueExport).mockRejectedValue(
      new UnauthorizedError('Token does not grant export capability'),
    )

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/rights/export',
      headers: { authorization: `Bearer ${VALID_BEARER}` },
    })

    expect(res.statusCode).toBe(401)
  })

  // ── Test 6: enqueue failure → 503 ────────────────────────────────────────

  it('returns 503 when export job enqueue fails', async () => {
    vi.mocked(enqueueExport).mockRejectedValue(
      new ServiceUnavailableError('Failed to enqueue export — please try again'),
    )

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/rights/export',
      headers: { authorization: `Bearer ${VALID_BEARER}` },
    })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } })
  })
})

// ── POST /utility/rights/delete (API-RIGHTS-002) ──────────────────────────────

describe('POST /utility/rights/delete (API-RIGHTS-002)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createApp()
  })

  afterEach(async () => {
    await app.close()
    vi.resetAllMocks()
  })

  // ── Test 1: happy path ────────────────────────────────────────────────────

  it('returns 202 with referenceId on valid delete token', async () => {
    vi.mocked(enqueueDelete).mockResolvedValue({ referenceId: 'delete:recipient-uuid' })

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/rights/delete',
      headers: { authorization: `Bearer ${VALID_BEARER}` },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ referenceId: 'delete:recipient-uuid' })
    expect(vi.mocked(enqueueDelete)).toHaveBeenCalledOnce()
  })

  // ── Test 2: missing Authorization header ──────────────────────────────────

  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url:    '/utility/rights/delete',
    })

    expect(res.statusCode).toBe(401)
    expect(vi.mocked(enqueueDelete)).not.toHaveBeenCalled()
  })

  // ── Test 3: invalid token ─────────────────────────────────────────────────

  it('returns 401 when token is invalid or expired', async () => {
    vi.mocked(enqueueDelete).mockRejectedValue(new UnauthorizedError('Invalid or expired token'))

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/rights/delete',
      headers: { authorization: `Bearer ${VALID_BEARER}` },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
  })

  // ── Test 4: revoked token ─────────────────────────────────────────────────

  it('returns 401 when token has been revoked', async () => {
    vi.mocked(enqueueDelete).mockRejectedValue(new UnauthorizedError('Token has been revoked'))

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/rights/delete',
      headers: { authorization: `Bearer ${VALID_BEARER}` },
    })

    expect(res.statusCode).toBe(401)
  })

  // ── Test 5: token lacks delete capability ────────────────────────────────

  it('returns 401 when token does not grant delete capability', async () => {
    vi.mocked(enqueueDelete).mockRejectedValue(
      new UnauthorizedError('Token does not grant delete capability'),
    )

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/rights/delete',
      headers: { authorization: `Bearer ${VALID_BEARER}` },
    })

    expect(res.statusCode).toBe(401)
  })

  // ── Test 6: enqueue failure → 503 ────────────────────────────────────────

  it('returns 503 when delete job enqueue fails', async () => {
    vi.mocked(enqueueDelete).mockRejectedValue(
      new ServiceUnavailableError('Failed to enqueue deletion — please try again'),
    )

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/rights/delete',
      headers: { authorization: `Bearer ${VALID_BEARER}` },
    })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } })
  })

  // ── Test 7: token is revoked after delete enqueue ─────────────────────────
  // enqueueDelete internally revokes the session post-enqueue (best-effort, fire-and-forget).
  // This test verifies the route returns 202 regardless of revocation outcome.

  it('returns 202 even if post-enqueue token revocation is fire-and-forget', async () => {
    vi.mocked(enqueueDelete).mockResolvedValue({ referenceId: 'delete:recipient-uuid' })

    const res = await app.inject({
      method:  'POST',
      url:     '/utility/rights/delete',
      headers: { authorization: `Bearer ${VALID_BEARER}` },
    })

    // Route returns 202 — revocation is handled inside enqueueDelete, not visible here
    expect(res.statusCode).toBe(202)
  })
})
