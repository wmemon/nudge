import { Queue } from 'bullmq'
import { createRedisConnection } from './redis-connection.js'

// ── Queue name registry ────────────────────────────────────────────────────────

export const QUEUE_NAMES = {
  INBOUND_CONTINUATION: 'inbound-continuation',
  SCHEDULED_CHECKIN:    'scheduled-checkin',
  EXPORT_FULFILLMENT:   'export-fulfillment',
  DELETE_FULFILLMENT:   'delete-fulfillment',
  /** Single maintenance queue — job type discriminated by payload `type` field.
   *  Handles: 7-day-stop, 90-day-purge, housekeeping */
  MAINTENANCE:          'maintenance',
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]

// ── Queue singletons ───────────────────────────────────────────────────────────

const _queues = new Map<QueueName, Queue>()

/**
 * Returns (or creates) the singleton BullMQ Queue for the given name.
 * All queues share the same Redis connection pool.
 */
export function getQueue(name: QueueName): Queue {
  if (_queues.has(name)) return _queues.get(name)!

  const queue = new Queue(name, { connection: createRedisConnection() })
  _queues.set(name, queue)
  return queue
}

/** Close all open queue connections. Call during graceful shutdown. */
export async function closeQueues(): Promise<void> {
  await Promise.all([..._queues.values()].map((q) => q.close()))
  _queues.clear()
}
