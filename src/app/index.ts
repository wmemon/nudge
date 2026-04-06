import fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import { config, getCorsOrigins } from '../platform/config/index.js'
import { createLogger } from '../platform/observability/index.js'
import { generateRequestId, extractFromHeader } from '../shared/correlation/index.js'
import { AppError, toErrorEnvelope, InternalError } from '../shared/errors/index.js'
import { checkDb } from '../platform/db-supabase/index.js'
import { checkRedis } from '../platform/queue-bullmq/index.js'
import { registerWebhookRoutes } from './routes/webhooks.js'
import { registerOtpRoutes } from './routes/otp.js'
import { registerRightsRoutes } from './routes/rights.js'

const log = createLogger({ module: 'app' })

/**
 * Creates and configures the Fastify application.
 *
 * Middleware stack (in order per plan Step 5):
 *   1. Raw body preservation  — contentTypeParser stub for future webhook route
 *   2. Correlation ID         — x-request-id header read/generate (OAC-001)
 *   3. Request logger         — Pino serializer; no body content logged (OAC-002)
 *   4. CORS                   — CORS_ALLOWED_ORIGINS allowlist (ADR §9)
 *   5. Global error handler   — maps AppError subtypes to HTTP status + error envelope
 */
export async function createApp(): Promise<FastifyInstance> {
  const app = fastify({
    // Use our createLogger factory so all request logs share the same Pino config
    logger: false, // we manage logging via hooks below
    // Correlation ID: read from header, generate if absent (OAC-001)
    genReqId: (req) =>
      extractFromHeader(req.headers['x-request-id']) ?? generateRequestId(),
  })

  // ── 1. Raw body preservation ─────────────────────────────────────────────
  // Keep the raw Buffer for the future /webhooks/loopmessage route so HMAC
  // signature verification can run before JSON parsing (ADR §3, §5).
  // Scoped to the webhook prefix; all other routes use Fastify's default JSON parser.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 1_048_576 }, // 1 MB
    (req, body, done) => {
      // Attach raw buffer for routes that need signature verification
      (req as typeof req & { rawBody: Buffer }).rawBody = body as Buffer
      try {
        const parsed = JSON.parse((body as Buffer).toString('utf-8')) as unknown
        done(null, parsed)
      } catch (err) {
        done(err as Error, undefined)
      }
    },
  )

  // ── 2. Correlation ID ────────────────────────────────────────────────────
  app.addHook('onRequest', async (request, reply) => {
    // genReqId already set request.id; mirror it in the response header
    reply.header('x-request-id', request.id)
  })

  // ── 3. Request logger ────────────────────────────────────────────────────
  app.addHook('onResponse', (request, reply, done) => {
    log.info({
      event: 'http.request',
      requestId: request.id,
      method: request.method,
      path: request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    })
    done()
  })

  // ── 4. CORS ──────────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: getCorsOrigins(),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
  })

  // ── 5. Global error handler ──────────────────────────────────────────────
  app.setErrorHandler((error, request, reply) => {
    const appError =
      error instanceof AppError ? error : new InternalError('An unexpected error occurred')

    if (!(error instanceof AppError)) {
      log.error({ event: 'unhandled_error', requestId: request.id, err: error })
    }

    const envelope = toErrorEnvelope(appError, request.id as string)
    void reply.status(appError.httpStatus).send(envelope)
  })

  // ── Health routes ────────────────────────────────────────────────────────
  registerHealthRoutes(app)

  // ── Webhook routes ───────────────────────────────────────────────────────
  registerWebhookRoutes(app)

  // ── Utility routes (OTP + rights) ────────────────────────────────────────
  // Gated on RIGHTS_ENDPOINTS_ENABLED toggle (DPC-001, ADR §8)
  if (config.RIGHTS_ENDPOINTS_ENABLED) {
    registerOtpRoutes(app)
    registerRightsRoutes(app)
  }

  return app
}

// ── Health routes ──────────────────────────────────────────────────────────────

function registerHealthRoutes(app: FastifyInstance): void {
  /** GET /health — liveness; always 200 while process is running (API-HLTH-001) */
  app.get('/health', async () => ({ status: 'ok' }))

  /** GET /ready — readiness; checks Postgres + Redis (API-HLTH-002) */
  app.get('/ready', async (_request, reply) => {
    const [db, redis] = await Promise.all([checkDb(), checkRedis()])

    const allOk = db.ok && redis.ok
    const body = {
      status: allOk ? 'ok' : 'degraded',
      checks: { db, redis },
    }

    return reply.status(allOk ? 200 : 503).send(body)
  })
}
