import type { SupabaseClient } from '../../../platform/db-supabase/index.js'
import { InternalError } from '../../../shared/errors/index.js'
import type { ProactivePolicyState } from '../domain/index.js'

// ── Row mapper ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPolicyState(row: Record<string, any>): ProactivePolicyState {
  return {
    id:                      row.id                        as string,
    recipientId:             row.recipient_id              as string,
    lastProactiveSentAt:     row.last_proactive_sent_at
                               ? new Date(row.last_proactive_sent_at as string)
                               : null,
    effectiveSpacingMinutes: row.effective_spacing_minutes as number,
    rolling24hCount:         row.rolling_24h_count         as number,
    rolling24hWindowStart:   new Date(row.rolling_24h_window_start as string),
    proactiveCount7d:        row.proactive_count_7d        as number,
    inboundReplies7d:        row.inbound_replies_7d        as number,
    window7dStartedAt:       new Date(row.window_7d_started_at as string),
    createdAt:               new Date(row.created_at       as string),
    updatedAt:               new Date(row.updated_at       as string),
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * Returns the proactive policy state for a recipient, or null if no row exists yet.
 * DDC-003: scoped to a single recipientId.
 */
export async function findPolicyState(
  supabase: SupabaseClient,
  recipientId: string,
): Promise<ProactivePolicyState | null> {
  const { data, error } = await supabase
    .from('proactive_policy_state')
    .select('*')
    .eq('recipient_id', recipientId)
    .maybeSingle()

  if (error) throw new InternalError(`findPolicyState failed: ${error.message}`)
  return data ? toPolicyState(data) : null
}

/**
 * Patch shape accepted by upsertPolicyState.
 * All fields are optional — only supplied fields are written.
 * recipient_id, created_at are managed by the DB or set on first insert only.
 */
export interface PolicyStatePatch {
  lastProactiveSentAt?:     Date | null
  effectiveSpacingMinutes?: number
  rolling24hCount?:         number
  rolling24hWindowStart?:   Date
  proactiveCount7d?:        number
  inboundReplies7d?:        number
  window7dStartedAt?:       Date
}

/**
 * Inserts or updates the proactive policy state row for a recipient.
 * On first insert all columns must be derivable; on conflict (recipient_id)
 * only the supplied patch fields are updated.
 * DDC-003: scoped to a single recipientId.
 */
export async function upsertPolicyState(
  supabase: SupabaseClient,
  recipientId: string,
  patch: PolicyStatePatch,
): Promise<ProactivePolicyState> {
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('proactive_policy_state')
    .upsert(
      {
        recipient_id:              recipientId,
        last_proactive_sent_at:    patch.lastProactiveSentAt !== undefined
                                     ? (patch.lastProactiveSentAt?.toISOString() ?? null)
                                     : undefined,
        effective_spacing_minutes: patch.effectiveSpacingMinutes,
        rolling_24h_count:         patch.rolling24hCount,
        rolling_24h_window_start:  patch.rolling24hWindowStart?.toISOString(),
        proactive_count_7d:        patch.proactiveCount7d,
        inbound_replies_7d:        patch.inboundReplies7d,
        window_7d_started_at:      patch.window7dStartedAt?.toISOString(),
        updated_at:                now,
      },
      { onConflict: 'recipient_id', ignoreDuplicates: false },
    )
    .select('*')
    .single()

  if (error) throw new InternalError(`upsertPolicyState failed: ${error.message}`)
  if (!data)  throw new InternalError('upsertPolicyState returned no row')

  return toPolicyState(data)
}
