import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

// ── Mocks (hoisted before imports) ────────────────────────────────────────────

vi.mock('../../src/platform/loopmessage-adapter/index.js', () => ({
  verifyWebhookSignature: vi.fn(),
}))

vi.mock('../../src/modules/webhook-ingestion/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/modules/webhook-ingestion/index.js')>()
  return {
    ...real,
    // Keep real normalizeLoopMessagePayload so payload validation tests work correctly
    ingestWebhookEvent: vi.fn(),
  }
})

vi.mock('../../src/platform/queue-bullmq/queues.js', () => ({
  getQueue: vi.fn(),
  QUEUE_NAMES: { INBOUND_CONTINUATION: 'inbound-continuation' },
  closeQueues: vi.fn(),
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

const { verifyWebhookSignature } = await import('../../src/platform/loopmessage-adapter/index.js')
const { ingestWebhookEvent } = await import('../../src/modules/webhook-ingestion/index.js')
const { getQueue } = await import('../../src/platform/queue-bullmq/queues.js')
const { createApp } = await import('../../src/app/index.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_PAYLOAD = {
  webhook_id: 'wh-uuid-001',
  event: 'message_inbound',
  contact: '+13231112233',
  text: 'I went to the gym today!',
}

function makeAcceptedResult() {
  return {
    status: 'accepted' as const,
    event: { id: 'db-uuid', webhookId: 'wh-uuid-001', receivedAt: new Date(), processedAt: null },
    normalized: { webhookId: 'wh-uuid-001', event: 'message_inbound', recipientHandle: '+13231112233', text: 'I went to the gym today!' },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /webhooks/loopmessage (API-WH-001)', () => {
  let app: FastifyInstance
  let mockAdd: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    mockAdd = vi.fn().mockResolvedValue({ id: 'job-123' })
    vi.mocked(getQueue).mockReturnValue({ add: mockAdd } as never)
    app = await createApp()
  })

  afterEach(async () => {
    await app.close()
    vi.resetAllMocks()
  })

  // ── Test 1: happy path ─────────────────────────────────────────────────────

  it('returns 200 and enqueues job on valid new event', async () => {
    vi.mocked(verifyWebhookSignature).mockReturnValue(true)
    vi.mocked(ingestWebhookEvent).mockResolvedValue(makeAcceptedResult())

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/loopmessage',
      payload: VALID_PAYLOAD,
    })

    expect(res.statusCode).toBe(200)
    expect(mockAdd).toHaveBeenCalledOnce()
    expect(mockAdd).toHaveBeenCalledWith(
      'inbound-continuation',
      expect.objectContaining({ webhookId: 'wh-uuid-001', recipientHandle: '+13231112233' }),
      expect.objectContaining({ jobId: 'wh-uuid-001' }),
    )
  })

  // ── Test 2: duplicate delivery ─────────────────────────────────────────────

  it('returns 200 without enqueuing on duplicate webhook_id (AIC-001)', async () => {
    vi.mocked(verifyWebhookSignature).mockReturnValue(true)
    vi.mocked(ingestWebhookEvent).mockResolvedValue({ status: 'duplicate' })

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/loopmessage',
      payload: VALID_PAYLOAD,
    })

    expect(res.statusCode).toBe(200)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  // ── Test 3: missing auth header ────────────────────────────────────────────

  it('returns 401 when auth header is missing', async () => {
    vi.mocked(verifyWebhookSignature).mockReturnValue(false)

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/loopmessage',
      payload: VALID_PAYLOAD,
    })

    expect(res.statusCode).toBe(401)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  // ── Test 4: malformed body ─────────────────────────────────────────────────

  it('returns 400 when required payload fields are missing (VID-001)', async () => {
    vi.mocked(verifyWebhookSignature).mockReturnValue(true)

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/loopmessage',
      payload: { event: 'message_inbound', text: 'hello' }, // missing webhook_id and contact
    })

    expect(res.statusCode).toBe(400)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  // ── Test 5: non-inbound event type ─────────────────────────────────────────

  it('returns 200 without enqueuing for non-message_inbound events', async () => {
    vi.mocked(verifyWebhookSignature).mockReturnValue(true)
    vi.mocked(ingestWebhookEvent).mockResolvedValue({ status: 'skipped', reason: 'unhandled event type: message_reaction' })

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/loopmessage',
      payload: { ...VALID_PAYLOAD, event: 'message_reaction' },
    })

    expect(res.statusCode).toBe(200)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  // ── Test 6: enqueue failure after commit ────────────────────────────────────

  it('returns 503 when enqueue fails after idempotency commit (AIC-002)', async () => {
    vi.mocked(verifyWebhookSignature).mockReturnValue(true)
    vi.mocked(ingestWebhookEvent).mockResolvedValue(makeAcceptedResult())
    mockAdd.mockRejectedValue(new Error('Redis connection lost'))

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/loopmessage',
      payload: VALID_PAYLOAD,
    })

    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } })
  })

  // ── Test 7: empty auth header value ───────────────────────────────────────

  it('returns 401 when auth header value is empty string', async () => {
    vi.mocked(verifyWebhookSignature).mockReturnValue(false)

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/loopmessage',
      payload: VALID_PAYLOAD,
      headers: { 'x-loopmessage-secret': '' },
    })

    expect(res.statusCode).toBe(401)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  // ── Test 8: wrong auth header value ───────────────────────────────────────

  it('returns 401 when auth header has wrong secret value', async () => {
    vi.mocked(verifyWebhookSignature).mockReturnValue(false)

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/loopmessage',
      payload: VALID_PAYLOAD,
      headers: { 'x-loopmessage-secret': 'wrong-secret-value' },
    })

    expect(res.statusCode).toBe(401)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  // ── Test 9: image-only message (no text field) ─────────────────────────────

  it('returns 200 and enqueues when text field is absent (image-only message)', async () => {
    vi.mocked(verifyWebhookSignature).mockReturnValue(true)
    vi.mocked(ingestWebhookEvent).mockResolvedValue({
      status: 'accepted' as const,
      event: { id: 'db-uuid-2', webhookId: 'wh-uuid-002', receivedAt: new Date(), processedAt: null },
      normalized: { webhookId: 'wh-uuid-002', event: 'message_inbound', recipientHandle: '+13231112233', text: '' },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/loopmessage',
      payload: { webhook_id: 'wh-uuid-002', event: 'message_inbound', contact: '+13231112233' }, // no text
    })

    expect(res.statusCode).toBe(200)
    expect(mockAdd).toHaveBeenCalledOnce()
  })
})
