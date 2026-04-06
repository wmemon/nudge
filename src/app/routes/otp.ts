import type { FastifyInstance } from 'fastify'
import { requestOtp, verifyOtp } from '../../modules/otp-verification/index.js'
import { createLogger } from '../../platform/observability/index.js'
import { parseOrThrow, z } from '../../shared/validation/index.js'

const log = createLogger({ module: 'otp-routes' })

// ── Validation schemas ────────────────────────────────────────────────────────

const RequestOtpBodySchema = z.object({
  // E.164 phone number — the only supported format for LoopMessage recipient handles (Q4.R2)
  handle:         z.string().regex(/^\+[1-9]\d{7,14}$/, 'handle must be a valid E.164 phone number'),
  turnstileToken: z.string().min(1, 'turnstileToken is required'),
})

const VerifyOtpBodySchema = z.object({
  sessionId: z.string().uuid('sessionId must be a valid UUID'),
  code:      z.string().regex(/^\d{6}$/, 'code must be exactly 6 digits'),
})

// ── Route registration ────────────────────────────────────────────────────────

export function registerOtpRoutes(app: FastifyInstance): void {
  /**
   * POST /utility/otp/request — API-OTP-001
   *
   * Sends an OTP to the given recipient via LoopMessage.
   * Turnstile token required; unknown recipients return the same 200 response
   * as a known recipient to prevent enumeration (SPC-004, Q4.R2).
   */
  app.post('/utility/otp/request', async (request, reply) => {
    const body = parseOrThrow(RequestOtpBodySchema, request.body)

    const result = await requestOtp({
      recipientHandle: body.handle,
      turnstileToken:  body.turnstileToken,
      correlationId:   request.id as string,
    })

    log.info({ event: 'otp.request.handled', requestId: request.id, sent: result.sessionId !== null })

    // Always 200 with the same shape — unknown recipient returns sessionId: null
    // The client should display a generic "if this number is registered, you'll receive a code" message
    return reply.status(200).send({ status: 'ok', sessionId: result.sessionId })
  })

  /**
   * POST /utility/otp/verify — API-OTP-002
   *
   * Verifies the submitted OTP code and issues an opaque bearer token scoped
   * to export + delete capabilities for the verified recipient.
   */
  app.post('/utility/otp/verify', async (request, reply) => {
    const body = parseOrThrow(VerifyOtpBodySchema, request.body)

    const result = await verifyOtp({
      sessionId:     body.sessionId,
      code:          body.code,
      correlationId: request.id as string,
    })

    return reply.status(200).send({
      token:     result.token,
      expiresAt: result.expiresAt.toISOString(),
    })
  })
}
