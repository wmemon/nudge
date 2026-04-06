import type { SupabaseClient } from '../../../platform/db-supabase/index.js'
import { InternalError } from '../../../shared/errors/index.js'
import type { MetricType, UsageCounter } from '../domain/index.js'

// ── Row mapper ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toUsageCounter(row: Record<string, any>): UsageCounter {
  return {
    id:          row.id          as string,
    recipientId: row.recipient_id as string,
    metricType:  row.metric_type  as MetricType,
    count:       row.count        as number,
    updatedAt:   new Date(row.updated_at as string),
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Returns the current counter row for a recipient + metric, or null if no row
 * exists yet (count is effectively 0).
 * DDC-003: scoped to a single recipientId.
 */
export async function getCounter(
  supabase: SupabaseClient,
  recipientId: string,
  metricType: MetricType,
): Promise<UsageCounter | null> {
  const { data, error } = await supabase
    .from('usage_counters')
    .select('*')
    .eq('recipient_id', recipientId)
    .eq('metric_type', metricType)
    .maybeSingle()

  if (error) throw new InternalError(`getCounter failed: ${error.message}`)
  return data ? toUsageCounter(data) : null
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Increments the counter for a recipient + metric by 1 and returns the updated row.
 *
 * Implementation: two-step read-then-upsert (non-atomic).
 * This is intentional for MVP — counters are soft metering only and are never
 * used for billing or hard enforcement (Q1.R1). A count that is off by ±1 under
 * rare concurrent increments is acceptable.
 *
 * TODO: replace with a Postgres RPC for atomic increment when hard enforcement
 * is enabled (resolved-architecture-intake §16-17).
 *
 * DDC-003: scoped to a single recipientId.
 */
export async function incrementCounter(
  supabase: SupabaseClient,
  recipientId: string,
  metricType: MetricType,
): Promise<UsageCounter> {
  const current  = await getCounter(supabase, recipientId, metricType)
  const newCount = (current?.count ?? 0) + 1

  const { data, error } = await supabase
    .from('usage_counters')
    .upsert(
      {
        recipient_id: recipientId,
        metric_type:  metricType,
        count:        newCount,
        updated_at:   new Date().toISOString(),
      },
      { onConflict: 'recipient_id,metric_type', ignoreDuplicates: false },
    )
    .select('*')
    .single()

  if (error) throw new InternalError(`incrementCounter failed: ${error.message}`)
  if (!data)  throw new InternalError('incrementCounter returned no row')

  return toUsageCounter(data)
}
