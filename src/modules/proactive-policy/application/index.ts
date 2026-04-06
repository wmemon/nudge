import { getSupabaseClient } from '../../../platform/db-supabase/index.js'
import { config } from '../../../platform/config/index.js'
import { createLogger } from '../../../platform/observability/index.js'
import {
  findPolicyState,
  upsertPolicyState,
  type PolicyStatePatch,
} from '../data-access/index.js'
import type { ProactivePolicyState } from '../domain/index.js'

const log = createLogger({ module: 'proactive-policy' })

// ── Constants ─────────────────────────────────────────────────────────────────

const WINDOW_24H_MS  = 24 * 60 * 60 * 1000
const WINDOW_7D_MS   = 7  * 24 * 60 * 60 * 1000
const REPLY_RATE_THRESHOLD = 0.30
const BACKOFF_MULTIPLIER   = 1.5
const MAX_SPACING_MINUTES  = 2880 // 48h cap (ADR §13)

// ── Default state (used for a recipient who has never had a proactive send) ───

function defaultState(): Omit<ProactivePolicyState, 'id' | 'recipientId' | 'createdAt' | 'updatedAt'> {
  const now = new Date()
  return {
    lastProactiveSentAt:     null,
    effectiveSpacingMinutes: config.PROACTIVE_MIN_SPACING_MINUTES,
    rolling24hCount:         0,
    rolling24hWindowStart:   now,
    proactiveCount7d:        0,
    inboundReplies7d:        0,
    window7dStartedAt:       now,
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Checks whether a proactive send is allowed for this recipient right now.
 *
 * Evaluates two ADR §13 rules (in order):
 *   1. Rolling 24h cap — blocked if rolling_24h_count >= PROACTIVE_CAP_PER_24H
 *   2. Minimum spacing — blocked if last send was < effective_spacing_minutes ago
 *
 * Read-only: never mutates state.
 */
export async function checkCanSendProactive(
  recipientId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const supabase = getSupabaseClient()
  const raw      = await findPolicyState(supabase, recipientId)
  const state    = raw ?? { ...defaultState(), recipientId, id: '', createdAt: new Date(), updatedAt: new Date() }

  const now = Date.now()

  // Rule 1: rolling 24h cap
  const windowExpired = now - state.rolling24hWindowStart.getTime() >= WINDOW_24H_MS
  const countInWindow = windowExpired ? 0 : state.rolling24hCount

  if (countInWindow >= config.PROACTIVE_CAP_PER_24H) {
    log.info({ event: 'proactive.blocked.cap_24h', recipientId, countInWindow })
    return { allowed: false, reason: 'cap_24h' }
  }

  // Rule 2: minimum spacing
  if (state.lastProactiveSentAt !== null) {
    const elapsedMinutes = (now - state.lastProactiveSentAt.getTime()) / 60_000
    if (elapsedMinutes < state.effectiveSpacingMinutes) {
      log.info({ event: 'proactive.blocked.spacing', recipientId, elapsedMinutes, required: state.effectiveSpacingMinutes })
      return { allowed: false, reason: 'spacing' }
    }
  }

  return { allowed: true }
}

/**
 * Records a completed proactive send and updates the policy scoreboard.
 *
 * - Stamps last_proactive_sent_at = now
 * - Increments rolling_24h_count (resets window if expired)
 * - Increments proactive_count_7d (resets window if expired)
 * - Recomputes spacing backoff
 *
 * Must be called after a successful send, not before (AIC-003).
 */
export async function recordProactiveSent(recipientId: string): Promise<void> {
  const supabase = getSupabaseClient()
  const raw      = await findPolicyState(supabase, recipientId)
  const state    = raw ?? { ...defaultState(), recipientId, id: '', createdAt: new Date(), updatedAt: new Date() }

  const now = new Date()

  // 24h window — reset if expired
  const window24hExpired = now.getTime() - state.rolling24hWindowStart.getTime() >= WINDOW_24H_MS
  const new24hCount      = window24hExpired ? 1 : state.rolling24hCount + 1
  const new24hStart      = window24hExpired ? now : state.rolling24hWindowStart

  // 7d window — reset if expired
  const window7dExpired      = now.getTime() - state.window7dStartedAt.getTime() >= WINDOW_7D_MS
  const newProactiveCount7d  = window7dExpired ? 1 : state.proactiveCount7d + 1
  const newInboundReplies7d  = window7dExpired ? 0 : state.inboundReplies7d
  const new7dStart           = window7dExpired ? now : state.window7dStartedAt

  const newSpacing = recomputeBackoff(
    newProactiveCount7d,
    newInboundReplies7d,
    state.effectiveSpacingMinutes,
  )

  const patch: PolicyStatePatch = {
    lastProactiveSentAt:     now,
    effectiveSpacingMinutes: newSpacing,
    rolling24hCount:         new24hCount,
    rolling24hWindowStart:   new24hStart,
    proactiveCount7d:        newProactiveCount7d,
    inboundReplies7d:        newInboundReplies7d,
    window7dStartedAt:       new7dStart,
  }

  await upsertPolicyState(supabase, recipientId, patch)

  log.info({
    event:               'proactive.recorded_sent',
    recipientId,
    new24hCount,
    newSpacing,
    window24hExpired,
    window7dExpired,
  })
}

/**
 * Records an inbound reply from the user and updates the reply-rate window.
 *
 * - Increments inbound_replies_7d (resets window if expired)
 * - Recomputes spacing backoff
 *
 * Called for every inbound turn — an inbound message is always a "reply"
 * from the policy's perspective (ADR §13).
 */
export async function recordInboundReply(recipientId: string): Promise<void> {
  const supabase = getSupabaseClient()
  const raw      = await findPolicyState(supabase, recipientId)

  // No state row yet means this user has never received a proactive send.
  // We still create the row so the reply is counted when proactive sends begin.
  const state = raw ?? { ...defaultState(), recipientId, id: '', createdAt: new Date(), updatedAt: new Date() }

  const now = new Date()

  // 7d window — reset if expired
  const window7dExpired     = now.getTime() - state.window7dStartedAt.getTime() >= WINDOW_7D_MS
  const newInboundReplies7d = window7dExpired ? 1 : state.inboundReplies7d + 1
  const newProactiveCount7d = window7dExpired ? 0 : state.proactiveCount7d
  const new7dStart          = window7dExpired ? now : state.window7dStartedAt

  const newSpacing = recomputeBackoff(
    newProactiveCount7d,
    newInboundReplies7d,
    state.effectiveSpacingMinutes,
  )

  const patch: PolicyStatePatch = {
    effectiveSpacingMinutes: newSpacing,
    inboundReplies7d:        newInboundReplies7d,
    proactiveCount7d:        newProactiveCount7d,
    window7dStartedAt:       new7dStart,
  }

  await upsertPolicyState(supabase, recipientId, patch)

  log.info({
    event:             'proactive.recorded_reply',
    recipientId,
    newInboundReplies7d,
    newSpacing,
    window7dExpired,
  })
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Computes the new effective spacing in minutes based on the 7-day reply rate.
 *
 * - Reply rate < 30%  → multiply current spacing by 1.5×, cap at 2880 min (48h)
 * - Reply rate >= 30% → reset to config floor (PROACTIVE_MIN_SPACING_MINUTES)
 * - No proactive sends yet (denominator = 0) → no change
 */
function recomputeBackoff(
  proactiveCount7d: number,
  inboundReplies7d: number,
  currentSpacingMinutes: number,
): number {
  if (proactiveCount7d === 0) return currentSpacingMinutes

  const replyRate = inboundReplies7d / proactiveCount7d

  if (replyRate < REPLY_RATE_THRESHOLD) {
    return Math.min(
      Math.round(currentSpacingMinutes * BACKOFF_MULTIPLIER),
      MAX_SPACING_MINUTES,
    )
  }

  // Reply rate healthy — reset to config floor
  return config.PROACTIVE_MIN_SPACING_MINUTES
}
