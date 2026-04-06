import { Worker, type Job } from 'bullmq'
import { QUEUE_NAMES, createRedisConnection } from '../platform/queue-bullmq/index.js'
import { createLogger } from '../platform/observability/index.js'
import { handleInboundContinuation } from '../modules/webhook-ingestion/index.js'
import { handleScheduledCheckinJob } from '../modules/goal-scheduling/index.js'
import { fulfillExport, fulfillDelete } from '../modules/user-rights-ops/index.js'
import { enforceOutboundStop, enqueuePreGoalPurges } from '../modules/abandonment-lifecycle/index.js'

const log = createLogger({ module: 'worker-registry' })

const _workers: Worker[] = []

/**
 * Registers all BullMQ consumers.
 * Called once at worker-runner startup. Each consumer logs job identity fields
 * only — never logs job data content (OAC-002).
 */
export function registerAllConsumers(): void {
  _workers.push(
    createConsumer(QUEUE_NAMES.INBOUND_CONTINUATION, handleInboundContinuation),
    createConsumer(QUEUE_NAMES.SCHEDULED_CHECKIN,    handleScheduledCheckinJob),
    createConsumer(QUEUE_NAMES.EXPORT_FULFILLMENT,   fulfillExport),
    createConsumer(QUEUE_NAMES.DELETE_FULFILLMENT,   fulfillDelete),
    createConsumer(QUEUE_NAMES.MAINTENANCE,          handleMaintenance),
  )
}

/** Stop all consumers and wait for in-flight jobs (30s max). */
export async function closeAllConsumers(): Promise<void> {
  await Promise.all(_workers.map((w) => w.close()))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function createConsumer(queue: string, handler: (job: Job) => Promise<void>): Worker {
  const worker = new Worker(queue, handler, {
    connection:  createRedisConnection(),
    concurrency: 1, // explicit — one job at a time per queue (single-process worker boundary)
  })

  worker.on('failed', (job, err) => {
    log.error({ event: 'job.failed', jobId: job?.id, queue, err })
  })

  return worker
}

// ── Consumer stubs ────────────────────────────────────────────────────────────
// Each stub logs job identity fields only — never logs job.data content (OAC-002)

async function handleMaintenance(job: Job): Promise<void> {
  const jobType = job.data?.type as string | undefined
  log.info({ event: 'job.started', jobId: job.id, queue: QUEUE_NAMES.MAINTENANCE, jobType })

  switch (jobType) {
    case '7-day-stop':
      await enforceOutboundStop()
      break
    case '90-day-purge':
      await enqueuePreGoalPurges()
      break
    default:
      log.warn({ event: 'job.unknown_type', jobId: job.id, queue: QUEUE_NAMES.MAINTENANCE, jobType })
  }

  log.info({ event: 'job.completed', jobId: job.id, queue: QUEUE_NAMES.MAINTENANCE, jobType })
}
