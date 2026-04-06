/**
 * Worker entrypoint — deployed as Render Background Worker (Decision D8).
 * No HTTP port; processes BullMQ jobs from Redis queues.
 *
 * Boot order (plan Step 6):
 *   1. Load + validate config  → fail fast if anything is missing
 *   2. Init Sentry
 *   3. Create Redis connection  → validates config is present
 *   4. Register all queue consumers (stub handlers at this stage)
 *   5. Log worker.ready event
 *
 * Graceful shutdown on SIGTERM:
 *   1. Log "SIGTERM received, draining..."
 *   2. Stop all consumers from accepting new jobs
 *   3. Wait up to 30s for in-flight jobs to finish
 *   4. closeQueues()
 *   5. process.exit(0)
 */

// Step 1: config validated at import time
import { config } from '../platform/config/index.js'
import { initSentry } from '../platform/observability/sentry.js'
import { createLogger } from '../platform/observability/logger.js'
import { createRedisConnection, closeQueues, getQueue, QUEUE_NAMES } from '../platform/queue-bullmq/index.js'
import { registerAllConsumers, closeAllConsumers } from './worker-registry.js'

const log = createLogger({ module: 'worker-runner' })

const SHUTDOWN_TIMEOUT_MS = 30_000

async function main(): Promise<void> {
  // Step 2: Init Sentry (no-op if SENTRY_DSN is empty)
  initSentry()

  // Step 3: Verify Redis connection
  const redis = createRedisConnection()
  await redis.ping()
  await redis.quit()
  log.debug({ event: 'redis.ping.ok' })

  // Step 4: Register all consumers
  registerAllConsumers()
  await scheduleMaintenanceJobs()

  // Step 5: Signal readiness
  log.info({
    event: 'worker.ready',
    consumers: Object.values(QUEUE_NAMES),
    nodeEnv: config.NODE_ENV,
  })

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = () => {
    log.info({ event: 'shutdown.received', msg: 'Draining workers...' })

    const timer = setTimeout(() => {
      log.warn({ event: 'shutdown.timeout', msg: 'Forced exit after 30s timeout' })
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)

    // clearTimeout so the timer doesn't keep the process alive if shutdown is fast
    timer.unref()

    void closeAllConsumers()
      .then(() => closeQueues())
      .then(() => {
        clearTimeout(timer)
        log.info({ event: 'worker.stopped' })
        process.exit(0)
      })
      .catch((err: unknown) => {
        log.error({ event: 'shutdown.error', err })
        process.exit(1)
      })
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT',  shutdown)
}

/**
 * Registers repeatable MAINTENANCE jobs in BullMQ.
 * BullMQ repeatable jobs are idempotent by name + cron pattern — safe to call on every restart.
 *
 * Schedule (UTC):
 *   02:00 — 7-day-stop  (enforce outbound stop for abandoned recipients)
 *   02:30 — 90-day-purge (enqueue delete jobs for pre-goal purge candidates)
 */
async function scheduleMaintenanceJobs(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.MAINTENANCE)
  await queue.add('7-day-stop',   { type: '7-day-stop'   }, { repeat: { pattern: '0 2 * * *'  } })
  await queue.add('90-day-purge', { type: '90-day-purge' }, { repeat: { pattern: '30 2 * * *' } })
  log.info({ event: 'maintenance.scheduled', jobs: ['7-day-stop', '90-day-purge'] })
}

main().catch((err: unknown) => {
  console.error('Fatal error during worker startup:', err)
  process.exit(1)
})
