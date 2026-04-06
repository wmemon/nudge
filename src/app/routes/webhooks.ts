import type { FastifyInstance, FastifyRequest } from 'fastify'
import { verifyWebhookSignature } from '../../platform/loopmessage-adapter/index.js'
import { getQueue, QUEUE_NAMES } from '../../platform/queue-bullmq/queues.js'
import { createLogger } from '../../platform/observability/index.js'
import { normalizeLoopMessagePayload, ingestWebhookEvent, markWebhookEventProcessed } from '../../modules/webhook-ingestion/index.js'
import { UnauthorizedError, ServiceUnavailableError } from '../../shared/errors/index.js'

const log = createLogger({ module: 'webhook-route' })

type RawBodyRequest = FastifyRequest & { rawBody: Buffer }

export function registerWebhookRoutes(app: FastifyInstance): void {
  /**
   * POST /webhooks/loopmessage — inbound LoopMessage event ingestion (API-WH-001)
   *
   * Order per AIC-001/AIC-002:
   *   1. Verify auth header (trust gate)
   *   2. Normalize + validate payload (VID-001/VID-003)
   *   3. Ingest: skip / dedupe / insert idempotency record
   *   4. Enqueue JOB-INBOUND-001
   *   5. Return 200 — or 503 if enqueue fails after commit (AIC-002)
   */
  app.post('/webhooks/loopmessage', async (request, reply) => {
    const req = request as RawBodyRequest

    // Step 1: verify shared-secret auth header (Part 1)
    const trusted = verifyWebhookSignature(req.rawBody, req.headers)
    if (!trusted) {
      throw new UnauthorizedError('Invalid webhook signature')
    }

    // Step 2: normalize + validate vendor payload (Part 3 adapter)
    // ValidationError (→ 400) is thrown here on malformed body and caught by global handler
    const normalized = normalizeLoopMessagePayload(req.body)

    // Step 3: ingest — idempotency check + record (Part 3 application service)
    const result = await ingestWebhookEvent(normalized)

    if (result.status === 'skipped') {
      log.info({ event: 'webhook.skipped', requestId: request.id, reason: result.reason })
      return reply.status(200).send({ status: 'ok' })
    }

    if (result.status === 'duplicate') {
      log.info({ event: 'webhook.duplicate', requestId: request.id, webhookId: normalized.webhookId })
      return reply.status(200).send({ status: 'ok' })
    }

    // Step 4: enqueue JOB-INBOUND-001
    // Log only non-sensitive identifiers — never log text content (OAC-002)
    try {
      await getQueue(QUEUE_NAMES.INBOUND_CONTINUATION).add(
        'inbound-continuation',
        {
          webhookId:       normalized.webhookId,
          recipientHandle: normalized.recipientHandle,
          text:            normalized.text,
          correlationId:   request.id,
        },
        {
          jobId:   normalized.webhookId,   // BullMQ dedup: same jobId = no duplicate job
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
        },
      )
    } catch (err) {
      // AIC-002: enqueue failed after idempotency commit — return 503 so LoopMessage retries.
      // The idempotency record is already committed; replay is safe.
      log.error({ event: 'webhook.enqueue_failed', requestId: request.id, webhookId: normalized.webhookId, err })
      throw new ServiceUnavailableError('Failed to enqueue inbound job — please retry')
    }

    // Stamp processed_at now that the job is safely enqueued (best-effort; non-critical)
    markWebhookEventProcessed(normalized.webhookId).catch((err) => {
      log.warn({ event: 'webhook.processed_at_update_failed', requestId: request.id, webhookId: normalized.webhookId, err })
    })

    log.info({ event: 'webhook.accepted', requestId: request.id, webhookId: normalized.webhookId })
    return reply.status(200).send({ status: 'ok' })
  })
}
