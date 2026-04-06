/**
 * One-off: enqueue the next scheduled check-in for a recipient (BullMQ delayed job).
 * Use when goal + schedule exist in Postgres but Redis never got a job (e.g. pre-fix enqueue failure).
 *
 * Usage (from repo root; env must match the worker — Supabase + Redis):
 *   Render Shell (injected env, no .env file): pnpm ops:arm-schedule -- <recipient-uuid>
 *   Local with .env: pnpm ops:arm-schedule:local -- <recipient-uuid>
 */

import { scheduleNextCheckin } from '../src/modules/goal-scheduling/index.js'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const args = process.argv.slice(2).filter((a) => a !== '--')
const raw = args[0]
if (!raw || !UUID_RE.test(raw)) {
  console.error('Usage: pnpm ops:arm-schedule -- <recipient-uuid>  (Render: injected env; local: pnpm ops:arm-schedule:local -- <uuid>)')
  process.exit(1)
}

await scheduleNextCheckin(raw)
console.info(`scheduleNextCheckin OK for recipient ${raw}`)
process.exit(0)
