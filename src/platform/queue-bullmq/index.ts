import type { Redis } from 'ioredis'

export { createRedisConnection } from './redis-connection.js'
export { QUEUE_NAMES, getQueue, closeQueues } from './queues.js'
export type { QueueName } from './queues.js'
// ── Redis health check ─────────────────────────────────────────────────────────

/**
 * Checks Redis liveness with PING.
 * Used by the /ready endpoint (API-HLTH-002).
 *
 * ADR §9 — fail closed: if Redis is unavailable, routes with Redis-backed
 * rate limits MUST return an error rather than silently skipping the check.
 */
export async function checkRedis(): Promise<{ ok: boolean; latencyMs: number }> {
  // Import here to avoid circular dependency (redis-connection ← index ← worker-registry)
  const { createRedisConnection } = await import('./redis-connection.js')
  const start = Date.now()
  let client: Redis | null = null
  try {
    client = createRedisConnection()
    await client.ping()
    return { ok: true, latencyMs: Date.now() - start }
  } catch {
    return { ok: false, latencyMs: Date.now() - start }
  } finally {
    await client?.quit().catch(() => undefined)
  }
}
