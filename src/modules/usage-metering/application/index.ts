import { getSupabaseClient } from '../../../platform/db-supabase/index.js'
import { config } from '../../../platform/config/index.js'
import { createLogger } from '../../../platform/observability/index.js'
import { evaluateThreshold } from '../domain/index.js'
import { incrementCounter } from '../data-access/index.js'

const log = createLogger({ module: 'usage-metering' })

// ── Result type ───────────────────────────────────────────────────────────────

export interface IncrementResult {
  /** New counter value after the increment. */
  count: number
  /**
   * True when count has reached the configured soft-warning threshold.
   * Always false in MVP (threshold defaults to 9999 — resolved-architecture-intake §17).
   * Callers may send a soft-warning iMessage when this is true.
   * TODO: wire up iMessage warning send in goal-scheduling callers once product
   *       defines numeric caps (Q1.R1, resolved-architecture-intake §16).
   */
  shouldWarn: boolean
}

// ── Use cases ─────────────────────────────────────────────────────────────────

/**
 * Increments the goals_set counter for a recipient and evaluates the soft-warning
 * threshold (Q1.R1).
 *
 * Called fire-and-forget from goal-scheduling after a goal is successfully captured.
 * Errors must be caught and swallowed by the caller — a counter failure must never
 * abort a goal capture.
 *
 * DDC-003: scoped to a single recipientId.
 */
export async function incrementGoalCount(recipientId: string): Promise<IncrementResult> {
  const supabase = getSupabaseClient()
  const counter  = await incrementCounter(supabase, recipientId, 'goals_set')
  const shouldWarn = evaluateThreshold(counter.count, config.USAGE_GOAL_WARN_THRESHOLD)

  if (shouldWarn) {
    // Log the warning signal — never log handle or message content (OAC-002)
    log.warn({
      event:       'usage.goal_warn',
      recipientId,
      count:       counter.count,
      threshold:   config.USAGE_GOAL_WARN_THRESHOLD,
    })
  }

  return { count: counter.count, shouldWarn }
}

/**
 * Increments the checkins_completed counter for a recipient and evaluates the
 * soft-warning threshold (Q1.R1).
 *
 * Called fire-and-forget from the scheduled check-in job handler after a check-in
 * message is successfully sent.
 * Errors must be caught and swallowed by the caller.
 *
 * DDC-003: scoped to a single recipientId.
 */
export async function incrementCheckinCount(recipientId: string): Promise<IncrementResult> {
  const supabase = getSupabaseClient()
  const counter  = await incrementCounter(supabase, recipientId, 'checkins_completed')
  const shouldWarn = evaluateThreshold(counter.count, config.USAGE_CHECKIN_WARN_THRESHOLD)

  if (shouldWarn) {
    log.warn({
      event:       'usage.checkin_warn',
      recipientId,
      count:       counter.count,
      threshold:   config.USAGE_CHECKIN_WARN_THRESHOLD,
    })
  }

  return { count: counter.count, shouldWarn }
}
