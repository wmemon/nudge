/**
 * One-off: enqueue the next scheduled check-in for a recipient (BullMQ delayed job).
 * Use when goal + schedule exist in Postgres but Redis never got a job (e.g. pre-fix enqueue failure).
 *
 * Usage (from repo root, same env as the worker):
 *   pnpm ops:arm-schedule -- <recipient-uuid>
 *   node --env-file=.env ./node_modules/tsx/dist/cli.mjs scripts/arm-schedule-next-checkin.ts <recipient-uuid>
 */

import { scheduleNextCheckin } from '../src/modules/goal-scheduling/index.js'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const raw = process.argv[2]
if (!raw || !UUID_RE.test(raw)) {
  console.error('Usage: pnpm ops:arm-schedule -- <recipient-uuid>')
  process.exit(1)
}

await scheduleNextCheckin(raw)
console.info(`scheduleNextCheckin OK for recipient ${raw}`)
process.exit(0)
