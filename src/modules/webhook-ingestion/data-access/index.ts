import type { getSupabaseClient } from '../../../platform/db-supabase/index.js'
import { ConflictError, InternalError } from '../../../shared/errors/index.js'
import type { WebhookEvent } from '../domain/index.js'

type DbClient = ReturnType<typeof getSupabaseClient>

// ── Row shape returned by Supabase ─────────────────────────────────────────────

interface WebhookEventRow {
  id: string
  webhook_id: string
  received_at: string
  processed_at: string | null
}

function rowToDomain(row: WebhookEventRow): WebhookEvent {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    receivedAt: new Date(row.received_at),
    processedAt: row.processed_at ? new Date(row.processed_at) : null,
  }
}

// ── Data-access functions ──────────────────────────────────────────────────────

/**
 * Returns true if a webhook event with the given webhook_id already exists.
 * Used by the application service before attempting an insert (AIC-001).
 */
export async function existsWebhookEvent(
  supabase: DbClient,
  webhookId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('webhook_events')
    .select('id')
    .eq('webhook_id', webhookId)
    .maybeSingle()

  if (error) throw new InternalError('Failed to query webhook_events')
  return data !== null
}

/**
 * Sets processed_at to now() for the given webhook_id.
 * Called after the inbound continuation job is successfully enqueued.
 * Returns silently on any DB error — a failed timestamp stamp is non-critical;
 * the idempotency record is already committed and the job is already enqueued.
 */
export async function markWebhookEventProcessed(
  supabase: DbClient,
  webhookId: string,
): Promise<void> {
  await supabase
    .from('webhook_events')
    .update({ processed_at: new Date().toISOString() })
    .eq('webhook_id', webhookId)
}

/**
 * Inserts a new webhook event idempotency record and returns the created row.
 * Throws ConflictError if the webhook_id already exists (concurrent duplicate delivery).
 * Throws InternalError on any other DB failure.
 */
export async function insertWebhookEvent(
  supabase: DbClient,
  webhookId: string,
): Promise<WebhookEvent> {
  const { data, error } = await supabase
    .from('webhook_events')
    .insert({ webhook_id: webhookId })
    .select()
    .single()

  if (error) {
    // Postgres unique violation code — concurrent duplicate delivery
    if (error.code === '23505') throw new ConflictError('Webhook event already processed')
    throw new InternalError('Failed to insert webhook_event')
  }

  // TODO: replace `as WebhookEventRow` with generated Supabase types once `supabase gen types` is run
  return rowToDomain(data as WebhookEventRow)
}
