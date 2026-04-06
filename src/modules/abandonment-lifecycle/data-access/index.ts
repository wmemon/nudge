import type { SupabaseClient } from '../../../platform/db-supabase/index.js'
import { InternalError } from '../../../shared/errors/index.js'
import type { AbandonedRecipient } from '../domain/index.js'
import { ABANDONMENT_STOP_DAYS, PURGE_DAYS } from '../domain/index.js'

// ── Batch limit ───────────────────────────────────────────────────────────────
//
// Process at most this many recipients per maintenance run.
// Large backlogs drain safely over multiple daily runs rather than hammering
// the queue or Postgres in a single pass. Tune upward if daily cadence cannot
// keep up with incoming volume at scale.

const BATCH_LIMIT = 200

// ── Row mapper ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toAbandoned(row: Record<string, any>): AbandonedRecipient {
  return {
    id:          row.id as string,
    firstSeenAt: new Date(row.first_seen_at as string),
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * Returns up to BATCH_LIMIT recipients eligible for the 7-day outbound stop.
 *
 * Eligibility criteria (Q3.R3):
 *   - onboarding_complete = false  (no goal ever set)
 *   - first_seen_at < NOW() - 7 days
 *   - globally_paused = false  (not already stopped)
 *
 * DDC-003: no recipient-id filter needed — this is an intentional cross-recipient
 * maintenance scan, not a user-facing read. Supabase service role is used server-side.
 */
export async function findRecipientsForOutboundStop(
  supabase: SupabaseClient,
): Promise<AbandonedRecipient[]> {
  const cutoff = new Date(Date.now() - ABANDONMENT_STOP_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('recipients')
    .select('id, first_seen_at')
    .eq('onboarding_complete', false)
    .eq('globally_paused', false)
    .lt('first_seen_at', cutoff)
    .limit(BATCH_LIMIT)

  if (error) throw new InternalError(`findRecipientsForOutboundStop failed: ${error.message}`)
  return (data ?? []).map(toAbandoned)
}

/**
 * Returns up to BATCH_LIMIT recipients eligible for the 90-day pre-goal purge.
 *
 * Eligibility criteria (Q3.R3, resolved-architecture-intake §15):
 *   - onboarding_complete = false  (no goal ever set)
 *   - first_seen_at < NOW() - 90 days  (avoids newly-created recipients with no messages)
 *   - No inbound message in the last 90 days
 *     ("inbound activity = any inbound message" — resolved-architecture-intake §15)
 *
 * The NOT EXISTS subquery is expressed as a join exclusion via Supabase's
 * .not() + inner join alternative. Because supabase-js does not expose NOT EXISTS
 * directly, we use a raw RPC-style approach via .rpc() or fall back to filtering
 * after a join. For clarity and correctness we use the PostgREST filtering
 * pattern: select recipients that have NO inbound message newer than 90 days.
 *
 * Implementation note: PostgREST does not support NOT EXISTS inline, so we use
 * a left join on the messages subquery and filter where the join produces null.
 * The query below is expressed as two chained Supabase calls for clarity, with
 * the subquery handled via a Postgres view alternative at the cost of one extra
 * round-trip — acceptable at MVP scale (~300 contacts/day).
 *
 * Approach: fetch candidate recipient ids first, then exclude any that have a
 * recent inbound message. Two round-trips; safe for batch sizes ≤ 200.
 */
export async function findRecipientsForPurge(
  supabase: SupabaseClient,
): Promise<AbandonedRecipient[]> {
  const cutoff90 = new Date(Date.now() - PURGE_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Step 1: candidates — no goal, first seen > 90 days ago
  const { data: candidates, error: candidateError } = await supabase
    .from('recipients')
    .select('id, first_seen_at')
    .eq('onboarding_complete', false)
    .lt('first_seen_at', cutoff90)
    .limit(BATCH_LIMIT)

  if (candidateError) throw new InternalError(`findRecipientsForPurge (candidates) failed: ${candidateError.message}`)
  if (!candidates || candidates.length === 0) return []

  const candidateIds = candidates.map((r) => r.id as string)

  // Step 2: find which candidates have had a recent inbound message
  const { data: active, error: activeError } = await supabase
    .from('messages')
    .select('recipient_id')
    .in('recipient_id', candidateIds)
    .eq('direction', 'inbound')
    .gt('created_at', cutoff90)

  if (activeError) throw new InternalError(`findRecipientsForPurge (active check) failed: ${activeError.message}`)

  const activeIds = new Set((active ?? []).map((m) => m.recipient_id as string))

  // Step 3: exclude recipients with recent inbound activity
  return candidates
    .filter((r) => !activeIds.has(r.id as string))
    .map(toAbandoned)
}
