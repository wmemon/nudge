import { DateTime } from 'luxon'
import { v4 as uuidv4 } from 'uuid'
import { getSupabaseClient } from '../../../platform/db-supabase/index.js'
import { getQueue, QUEUE_NAMES } from '../../../platform/queue-bullmq/queues.js'
import { createLogger } from '../../../platform/observability/index.js'
import { incrementGoalCount } from '../../usage-metering/index.js'
import {
  deactivatePriorGoals,
  insertGoal,
  findActiveGoal,
  findSchedule,
  insertMissedWindow,
  stampNextRunAt,
  upsertSchedule,
  type ScheduleInputs,
} from '../data-access/index.js'
import type { Goal, Schedule } from '../domain/index.js'

const log = createLogger({ module: 'goal-scheduling' })

// ── Constants ─────────────────────────────────────────────────────────────────

/** Don't schedule a check-in within this many minutes of now (avoids near-instant fires) */
const SCHEDULE_BUFFER_MINUTES = 5

/** Check-in jobs fired more than this many minutes late are treated as missed (Q12.3) */
export const MISSED_WINDOW_THRESHOLD_MINUTES = 60

/**
 * Deterministic BullMQ job id for a scheduled check-in at `runAt`.
 * Uses epoch ms in the third segment — ISO timestamps contain extra `:` and break BullMQ's
 * "exactly three colon-separated segments" rule (see docs/runbooks/bullmq-scheduled-checkin-job-id.md).
 */
export function scheduledCheckinQueueJobId(recipientId: string, runAt: Date): string {
  return `checkin:${recipientId}:${runAt.getTime()}`
}

// ── Job payload type (JOB-SCHED-001) ─────────────────────────────────────────
//
// Produced by scheduleNextCheckin(); consumed by the scheduled-checkin worker.

export interface ScheduledCheckinJobPayload {
  recipientId:  string
  /** ISO string of the originally scheduled check-in time (UTC) */
  scheduledAt:  string
  correlationId: string
}

// ── Schedule inputs (supplied by the LLM onboarding extraction) ───────────────

export interface GoalCaptureInputs {
  /** Goal statement extracted from the conversation */
  goalText: string
  /** Preferred check-in time as "HH:MM" (24h, local timezone); defaults to "09:00" */
  checkInTime: string
  /** IANA timezone string extracted from conversation; defaults to "UTC" */
  timezone: string
}

// ── Use cases ─────────────────────────────────────────────────────────────────

/**
 * Captures a new goal for a recipient.
 *
 * Steps:
 *   1. Deactivate any existing active goal (Q3.1 — one active goal per recipient)
 *   2. Insert the new goal row
 *   3. Upsert the recipient's schedule with the provided inputs
 *   4. Schedule the first check-in (computes next_run_at + enqueues BullMQ job)
 *
 * Caller is responsible for marking onboarding complete on the recipient
 * (identity-recipient module) after this returns successfully.
 */
export async function captureGoal(
  recipientId: string,
  inputs: GoalCaptureInputs,
): Promise<Goal> {
  const supabase = getSupabaseClient()

  // Step 1: deactivate prior goal (must happen before insert to satisfy partial unique index)
  // Step 2: insert new goal
  //
  // NOTE — known non-atomic gap (PROD-1): these are two separate DB round-trips with no
  // transaction. A process crash between them leaves the recipient with zero active goals.
  // Self-healing: getActiveGoal() returns null on the next inbound message, so the handler
  // re-enters onboarding mode and prompts the user to set their goal again.
  // supabase-js does not expose raw transactions; a Postgres RPC would be required for
  // full atomicity — deferred post-MVP.
  await deactivatePriorGoals(supabase, recipientId)

  const goal = await insertGoal(supabase, recipientId, inputs.goalText)

  log.info({ event: 'goal.captured', recipientId, goalId: goal.id })

  // Step 3: upsert schedule — quiet hours default to 10 pm–8 am local (MVP defaults)
  // Guard: ensure checkInTime is a valid HH:MM string (LLM may return malformed values
  // like "9:30 AM" despite the structured-output schema). Fall back to 09:00 if invalid.
  const HH_MM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
  const safeCheckInTime = HH_MM_RE.test(inputs.checkInTime) ? inputs.checkInTime : '09:00'

  const scheduleInputs: ScheduleInputs = {
    goalId:          goal.id,
    checkInTime:     safeCheckInTime,
    timezone:        inputs.timezone    || 'UTC',
    cadence:         'daily',
    quietHoursStart: 22,
    quietHoursEnd:   8,
  }
  await upsertSchedule(supabase, recipientId, scheduleInputs)

  // Step 4: compute next_run_at and enqueue first check-in job
  //
  // NOTE — known failure gap (PROD-4): if Redis is unavailable here, the goal and schedule
  // rows are already persisted but next_run_at remains null and no BullMQ job is enqueued.
  // The recipient will receive no check-ins until the gap is resolved.
  //
  // Detection: SELECT * FROM schedules WHERE next_run_at IS NULL AND updated_at > NOW() - INTERVAL '1 hour';
  // Recovery:  call scheduleNextCheckin(recipientId) once Redis is healthy.
  //
  // Self-healing path: if the recipient sends an inbound message, getActiveGoal() returns
  // the goal (active=true), so the handler stays in accountability mode and the next
  // scheduleNextCheckin() call in the inbound pipeline re-arms the job automatically.
  await scheduleNextCheckin(recipientId)

  // Fire-and-forget: increment usage counter — a counter failure must never abort goal capture (Q1.R1)
  incrementGoalCount(recipientId).catch((err: unknown) => {
    log.warn({ event: 'usage.increment_failed', metric: 'goals_set', recipientId, err })
  })

  return goal
}

/**
 * Returns the active goal for a recipient, or null if none exists.
 * Used by the inbound pipeline to determine onboarding vs. accountability mode.
 */
export async function getActiveGoal(recipientId: string): Promise<Goal | null> {
  const supabase = getSupabaseClient()
  return findActiveGoal(supabase, recipientId)
}

/**
 * Returns the schedule for a recipient, or null if none exists.
 * Single application-layer access point for schedule reads (MBC-001).
 */
export async function getScheduleForRecipient(recipientId: string): Promise<Schedule | null> {
  const supabase = getSupabaseClient()
  return findSchedule(supabase, recipientId)
}

/**
 * Computes the next valid check-in instant, stamps next_run_at, and enqueues
 * a BullMQ delayed job on the SCHEDULED_CHECKIN queue.
 *
 * Skips silently if:
 *   - No schedule row exists
 *   - Schedule is paused
 *   - Schedule is snoozed and snooze has not elapsed
 *
 * This is the single recompute path for next_run_at (ADR §4).
 */
export async function scheduleNextCheckin(recipientId: string): Promise<void> {
  const supabase = getSupabaseClient()

  const schedule = await findSchedule(supabase, recipientId)
  if (!schedule) return

  if (schedule.paused) {
    log.info({ event: 'schedule.skip.paused', recipientId })
    return
  }

  if (schedule.snoozeUntil && schedule.snoozeUntil > new Date()) {
    log.info({ event: 'schedule.skip.snoozed', recipientId })
    return
  }

  const nextRunAt = computeNextRunAt(
    schedule.checkInTime,
    schedule.timezone,
    schedule.quietHoursStart,
    schedule.quietHoursEnd,
  )

  // Stamp next_run_at — the only write path for this column (ADR §4)
  await stampNextRunAt(supabase, recipientId, nextRunAt)

  // Enqueue a delayed BullMQ job
  const payload: ScheduledCheckinJobPayload = {
    recipientId,
    scheduledAt:   nextRunAt.toISOString(),
    correlationId: uuidv4(),
  }

  const delayMs = Math.max(0, nextRunAt.getTime() - Date.now())

  await getQueue(QUEUE_NAMES.SCHEDULED_CHECKIN).add(
    'scheduled-checkin',
    payload,
    {
      // Deterministic jobId prevents duplicate jobs on retry (AIC-003)
      jobId:   scheduledCheckinQueueJobId(recipientId, nextRunAt),
      delay:   delayMs,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 }, // 1 min base
    },
  )

  log.info({ event: 'schedule.enqueued', recipientId, nextRunAt: nextRunAt.toISOString(), delayMs })
}

/**
 * Records a missed check-in window.
 * Called by the job handler when it detects a job fired too late (Q12.3).
 */
export async function recordMissedWindow(
  recipientId: string,
  scheduledAt: Date,
  reason: 'downtime' | 'paused' | 'quiet_hours',
): Promise<void> {
  const supabase = getSupabaseClient()
  await insertMissedWindow(supabase, recipientId, scheduledAt, reason)
  log.info({ event: 'missed_window.recorded', recipientId, scheduledAt: scheduledAt.toISOString(), reason })
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Computes the next UTC instant matching checkInTime in the given timezone.
 * Advances past quiet hours if the candidate falls within them.
 * Never returns a time within SCHEDULE_BUFFER_MINUTES of now.
 */
function computeNextRunAt(
  checkInTime: string,
  timezone: string,
  quietHoursStart: number,
  quietHoursEnd: number,
): Date {
  const [hour, minute] = checkInTime.split(':').map(Number) as [number, number]

  const now = DateTime.now().setZone(timezone)
  const bufferMs = SCHEDULE_BUFFER_MINUTES * 60 * 1000

  // Today's occurrence of checkInTime in the target timezone
  let candidate = now.set({ hour, minute, second: 0, millisecond: 0 })

  // If already passed (or within buffer), push to tomorrow
  if (candidate.toMillis() <= Date.now() + bufferMs) {
    candidate = candidate.plus({ days: 1 })
  }

  // Advance past quiet hours if needed
  candidate = advancePastQuietHours(candidate, quietHoursStart, quietHoursEnd)

  return candidate.toJSDate()
}

/**
 * If `dt` falls within the quiet window, advance to quietHoursEnd.
 * Handles midnight-spanning windows (start > end, e.g. 22–8).
 */
function advancePastQuietHours(
  dt: DateTime,
  start: number,
  end: number,
): DateTime {
  const hour = dt.hour

  const inQuiet =
    start > end
      ? hour >= start || hour < end    // spans midnight (e.g. 22–8)
      : hour >= start && hour < end    // same-day window (e.g. 14–16)

  if (!inQuiet) return dt

  // Advance to the start of the next quiet-free window
  let resumed = dt.set({ hour: end, minute: 0, second: 0, millisecond: 0 })
  if (resumed.toMillis() <= dt.toMillis()) {
    resumed = resumed.plus({ days: 1 })
  }
  return resumed
}
