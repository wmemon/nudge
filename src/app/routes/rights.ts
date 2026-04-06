import type { FastifyInstance } from 'fastify'
import { enqueueExport, enqueueDelete } from '../../modules/user-rights-ops/index.js'
import { createLogger } from '../../platform/observability/index.js'
import { UnauthorizedError } from '../../shared/errors/index.js'

const log = createLogger({ module: 'rights-routes' })

// ── Bearer token extraction ───────────────────────────────────────────────────

/**
 * Extracts the raw bearer token from the Authorization header.
 * Throws UnauthorizedError if the header is missing or malformed.
 */
function extractBearerToken(authHeader: string | undefined): string {
  if (!authHeader) {
    throw new UnauthorizedError('Authorization header is required')
  }
  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) {
    throw new UnauthorizedError('Authorization header must use Bearer scheme')
  }
  return parts[1]
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerRightsRoutes(app: FastifyInstance): void {
  /**
   * POST /utility/rights/export — API-RIGHTS-001
   *
   * Accepts a verified rights bearer token and enqueues an export fulfillment job.
   * Returns 202 Accepted with a referenceId for diagnostics.
   * Token must have been issued by API-OTP-002 and must not be expired or revoked.
   */
  app.post('/utility/rights/export', async (request, reply) => {
    const rawToken = extractBearerToken(request.headers.authorization)

    const result = await enqueueExport({
      rawToken,
      correlationId: request.id as string,
    })

    log.info({ event: 'rights.export.accepted', requestId: request.id, referenceId: result.referenceId })

    return reply.status(202).send({ referenceId: result.referenceId })
  })

  /**
   * POST /utility/rights/delete — API-RIGHTS-002
   *
   * Accepts a verified rights bearer token and enqueues an account deletion job.
   * Returns 202 Accepted with a referenceId for diagnostics.
   * Token is revoked after enqueue — it cannot be reused to trigger delete again.
   */
  app.post('/utility/rights/delete', async (request, reply) => {
    const rawToken = extractBearerToken(request.headers.authorization)

    const result = await enqueueDelete({
      rawToken,
      correlationId: request.id as string,
    })

    log.info({ event: 'rights.delete.accepted', requestId: request.id, referenceId: result.referenceId })

    return reply.status(202).send({ referenceId: result.referenceId })
  })
}
