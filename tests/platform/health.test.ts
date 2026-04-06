import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

vi.mock('../../src/platform/db-supabase/index.js', () => ({
  getSupabaseClient: vi.fn().mockReturnValue({}),
  checkDb: vi.fn(),
}))

vi.mock('../../src/platform/queue-bullmq/index.js', () => ({
  createRedisConnection: vi.fn().mockReturnValue({ ping: vi.fn(), quit: vi.fn() }),
  checkRedis: vi.fn(),
  QUEUE_NAMES: {},
  getQueue: vi.fn(),
  closeQueues: vi.fn(),
  registerAllConsumers: vi.fn(),
  closeAllConsumers: vi.fn(),
}))

const { checkDb } = await import('../../src/platform/db-supabase/index.js')
const { checkRedis } = await import('../../src/platform/queue-bullmq/index.js')
const { createApp } = await import('../../src/app/index.js')

describe('GET /health (API-HLTH-001)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createApp()
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns 200 with { status: ok }', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('echoes x-request-id on the response', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'test-id-123' },
    })
    expect(res.headers['x-request-id']).toBe('test-id-123')
  })
})

describe('GET /ready (API-HLTH-002)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createApp()
  })

  afterEach(async () => {
    await app.close()
  })

  it('returns 200 when both DB and Redis are healthy', async () => {
    vi.mocked(checkDb).mockResolvedValue({ ok: true, latencyMs: 5 })
    vi.mocked(checkRedis).mockResolvedValue({ ok: true, latencyMs: 2 })

    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      status: 'ok',
      checks: { db: { ok: true }, redis: { ok: true } },
    })
  })

  it('returns 503 when DB is unhealthy', async () => {
    vi.mocked(checkDb).mockResolvedValue({ ok: false, latencyMs: 0 })
    vi.mocked(checkRedis).mockResolvedValue({ ok: true, latencyMs: 2 })

    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({
      status: 'degraded',
      checks: { db: { ok: false }, redis: { ok: true } },
    })
  })

  it('returns 503 when Redis is unhealthy', async () => {
    vi.mocked(checkDb).mockResolvedValue({ ok: true, latencyMs: 5 })
    vi.mocked(checkRedis).mockResolvedValue({ ok: false, latencyMs: 0 })

    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({
      status: 'degraded',
      checks: { db: { ok: true }, redis: { ok: false } },
    })
  })
})
