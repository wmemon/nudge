/**
 * HTTP server entrypoint.
 *
 * Boot order (plan Step 5):
 *   1. Load + validate config  → fail fast if anything is missing
 *   2. Init Sentry
 *   3. Create Supabase client  → validates connection config is present
 *   4. Create Redis connection → validates connection config is present
 *   5. Create Fastify app with all middleware
 *   6. Mount health + ready routes
 *   7. Listen on PORT
 *   8. Register SIGTERM handler → fastify.close() → process.exit(0)
 */

// Step 1: config is loaded + validated at import time (fails fast on missing vars)
import { config } from '../platform/config/index.js'
import { initSentry } from '../platform/observability/sentry.js'
import { createLogger } from '../platform/observability/logger.js'
import { getSupabaseClient } from '../platform/db-supabase/index.js'
import { createRedisConnection } from '../platform/queue-bullmq/index.js'
import { createApp } from './index.js'

const log = createLogger({ module: 'http-server' })

async function main(): Promise<void> {
  // Step 2: Init Sentry (no-op if SENTRY_DSN is empty)
  initSentry()

  // Step 3: Create Supabase client (validates config is present; HTTP-based, no TCP conn)
  getSupabaseClient()
  log.debug({ event: 'supabase.client.created' })

  // Step 4: Verify Redis config is present (actual connection established on first use)
  const redis = createRedisConnection()
  // Smoke-test the connection before accepting traffic
  await redis.ping()
  await redis.quit()
  log.debug({ event: 'redis.ping.ok' })

  // Step 5+6: Create Fastify app (middleware + health routes)
  const app = await createApp()

  // Step 7: Listen
  await app.listen({ port: config.PORT, host: '0.0.0.0' })
  log.info({ event: 'server.ready', port: config.PORT })

  // Step 8: Graceful shutdown on SIGTERM (Render) and SIGINT (Ctrl+C in local dev)
  const shutdown = () => {
    log.info({ event: 'shutdown.received', msg: 'Shutting down HTTP server...' })
    void app.close().then(() => {
      log.info({ event: 'server.closed' })
      process.exit(0)
    })
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT',  shutdown)
}

main().catch((err: unknown) => {
  // Use console.error here because the logger may not be initialised yet
  console.error('Fatal error during server startup:', err)
  process.exit(1)
})
