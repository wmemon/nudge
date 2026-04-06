import { Redis } from 'ioredis'
import { config } from '../config/index.js'

/**
 * Creates a new ioredis connection with BullMQ-required options.
 * BullMQ requires a separate connection instance per Queue and Worker,
 * so this is a factory (not a singleton).
 */
export function createRedisConnection(): Redis {
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,    // required by BullMQ
  })
}
