import { DateTime } from 'luxon'
import type { SupabaseClient } from '../../../platform/db-supabase/index.js'
import { InternalError } from '../../../shared/errors/index.js'
import type { Goal, Schedule, MissedWindow } from '../domain/index.js'

// ── Row mappers ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toGoal(row: Record<string, any>): Goal {
  return {
    id:            row.id            as string,
    recipientId:   row.recipient_id  as string,
    text:          row.text          as string,
    active:        row.active        as boolean,
    deactivatedAt: row.deactivated_at ? new Date(row.deactivated_at as string) : null,
    createdAt:     new Date(row.created_at as string),
    updatedAt:     new Date(row.updated_at as string),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSchedule(row: Record<string, any>): Schedule {
  return {
    id:              row.id               as string,
    recipientId:     row.recipient_id     as string,
    goalId:          row.goal_id          as string,
    checkInTime:     row.check_in_time    as string,
    timezone:        row.timezone         as string,
    cadence:         row.cadence          as 'daily',
    quietHoursStart: row.quiet_hours_start as number,
    quietHoursEnd:   row.quiet_hours_end   as number,
    paused:          row.paused           as boolean,
    snoozeUntil:     row.snooze_until ? new Date(row.snooze_until as string) : null,
    nextRunAt:       row.next_run_at  ? new Date(row.next_run_at  as string) : null,
    createdAt:       new Date(row.created_at as string),
    updatedAt:       new Date(row.updated_at as string),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toMissedWindow(row: Record<string, any>): MissedWindow {
  return {
    id:           row.id           as string,
    recipientId:  row.recipient_id as string,
    scheduledAt:  new Date(row.scheduled_at as string),
    missedAt:     new Date(row.missed_at    as string),
    reason:       row.reason       as 'downtime' | 'paused' | 'quiet_hours',
    createdAt:    new Date(row.created_at   as string),
  }
}

// ── Goals ─────────────────────────────────────────────────────────────────────

/**
 * Returns the single active goal for a recipient, or null if none exists.
 * DDC-003: scoped to a single recipientId.
 */
export async function findActiveGoal(
  supabase: SupabaseClient,
  recipientId: string,
): Promise<Goal | null> {
  const { data, error } = await supabase
    .from('goals')
    .select('*')
    .eq('recipient_id', recipientId)
    .eq('active', true)
    .maybeSingle()

  if (error) throw new InternalError(`findActiveGoal failed: ${error.message}`)
  return data ? toGoal(data) : null
}

/**
 * Deactivates all active goals for a recipient before inserting a replacement.
 * Must be called before insertGoal to satisfy the partial unique index.
 * DDC-003: scoped to a single recipientId.
 */
export async function deactivatePriorGoals(
  supabase: SupabaseClient,
  recipientId: string,
): Promise<void> {
  const { error } = await supabase
    .from('goals')
    .update({ active: false, deactivated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('recipient_id', recipientId)
    .eq('active', true)

  if (error) throw new InternalError(`deactivatePriorGoals failed: ${error.message}`)
}

/**
 * Inserts a new active goal row and returns the persisted record.
 * Caller must have already called deactivatePriorGoals to avoid unique index violation.
 * DDC-003: scoped to a single recipientId.
 */
export async function insertGoal(
  supabase: SupabaseClient,
  recipientId: string,
  text: string,
): Promise<Goal> {
  const { data, error } = await supabase
    .from('goals')
    .insert({ recipient_id: recipientId, text, active: true })
    .select('*')
    .single()

  if (error) throw new InternalError(`insertGoal failed: ${error.message}`)
  if (!data)  throw new InternalError('insertGoal returned no row')

  return toGoal(data)
}

// ── Schedules ─────────────────────────────────────────────────────────────────

export interface ScheduleInputs {
  goalId:          string
  checkInTime:     string
  timezone:        string
  cadence:         'daily'
  quietHoursStart: number
  quietHoursEnd:   number
}

/**
 * Inserts or replaces the schedule for a recipient (upsert on recipient_id).
 * DDC-003: scoped to a single recipientId.
 */
export async function upsertSchedule(
  supabase: SupabaseClient,
  recipientId: string,
  inputs: ScheduleInputs,
): Promise<Schedule> {
  if (!DateTime.now().setZone(inputs.timezone).isValid) {
    throw new InternalError(`upsertSchedule: invalid IANA timezone "${inputs.timezone}"`)
  }

  const { data, error } = await supabase
    .from('schedules')
    .upsert(
      {
        recipient_id:      recipientId,
        goal_id:           inputs.goalId,
        check_in_time:     inputs.checkInTime,
        timezone:          inputs.timezone,
        cadence:           inputs.cadence,
        quiet_hours_start: inputs.quietHoursStart,
        quiet_hours_end:   inputs.quietHoursEnd,
        paused:            false,
        snooze_until:      null,
        next_run_at:       null,
        updated_at:        new Date().toISOString(),
      },
      { onConflict: 'recipient_id', ignoreDuplicates: false },
    )
    .select('*')
    .single()

  if (error) throw new InternalError(`upsertSchedule failed: ${error.message}`)
  if (!data)  throw new InternalError('upsertSchedule returned no row')

  return toSchedule(data)
}

/**
 * Returns the schedule for a recipient, or null if none exists.
 * DDC-003: scoped to a single recipientId.
 */
export async function findSchedule(
  supabase: SupabaseClient,
  recipientId: string,
): Promise<Schedule | null> {
  const { data, error } = await supabase
    .from('schedules')
    .select('*')
    .eq('recipient_id', recipientId)
    .maybeSingle()

  if (error) throw new InternalError(`findSchedule failed: ${error.message}`)
  return data ? toSchedule(data) : null
}

/**
 * Updates next_run_at on the schedule row.
 * This is the ONLY write path for next_run_at — all schedule recomputation
 * must go through this function (ADR §4).
 * DDC-003: scoped to a single recipientId.
 */
export async function stampNextRunAt(
  supabase: SupabaseClient,
  recipientId: string,
  nextRunAt: Date,
): Promise<void> {
  const { error } = await supabase
    .from('schedules')
    .update({ next_run_at: nextRunAt.toISOString(), updated_at: new Date().toISOString() })
    .eq('recipient_id', recipientId)

  if (error) throw new InternalError(`stampNextRunAt failed: ${error.message}`)
}

// ── Missed windows ────────────────────────────────────────────────────────────

/**
 * Records a missed check-in window.
 * Silently ignores duplicate inserts (same recipient_id + scheduled_at) —
 * retries are safe.
 * DDC-003: scoped to a single recipientId.
 */
export async function insertMissedWindow(
  supabase: SupabaseClient,
  recipientId: string,
  scheduledAt: Date,
  reason: MissedWindow['reason'],
): Promise<void> {
  const { error } = await supabase
    .from('missed_windows')
    .insert({
      recipient_id: recipientId,
      scheduled_at: scheduledAt.toISOString(),
      reason,
    })

  // Unique constraint violation = already recorded on a prior retry; ignore
  if (error && error.code !== '23505') {
    throw new InternalError(`insertMissedWindow failed: ${error.message}`)
  }
}
