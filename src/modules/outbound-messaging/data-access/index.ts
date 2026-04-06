import type { SupabaseClient } from '../../../platform/db-supabase/index.js'
import { InternalError } from '../../../shared/errors/index.js'
import type { OutboundSendIntent } from '../domain/index.js'

// ── Row mapper ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIntent(row: Record<string, any>): OutboundSendIntent {
  return {
    id:                 row.id as string,
    recipientId:        row.recipient_id as string,
    idempotencyKey:     row.idempotency_key as string,
    status:             row.status as 'pending' | 'delivered' | 'failed',
    providerMessageId:  row.provider_message_id as string | null,
    createdAt:          new Date(row.created_at as string),
    updatedAt:          new Date(row.updated_at as string),
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * Returns the send intent for the given idempotency key, or null if not found.
 * Used to detect already-delivered sends on job retry (AIC-003).
 */
export async function findSendIntent(
  supabase: SupabaseClient,
  idempotencyKey: string,
): Promise<OutboundSendIntent | null> {
  const { data, error } = await supabase
    .from('outbound_send_intents')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()

  if (error) throw new InternalError(`findSendIntent failed: ${error.message}`)
  if (!data) return null

  return toIntent(data)
}

/**
 * Inserts a new send intent with status 'pending'.
 * DDC-003: scoped to a single recipientId.
 */
export async function insertSendIntent(
  supabase: SupabaseClient,
  recipientId: string,
  idempotencyKey: string,
): Promise<OutboundSendIntent> {
  const { data, error } = await supabase
    .from('outbound_send_intents')
    .insert({ recipient_id: recipientId, idempotency_key: idempotencyKey, status: 'pending' })
    .select('*')
    .single()

  if (error) throw new InternalError(`insertSendIntent failed: ${error.message}`)
  if (!data)  throw new InternalError('insertSendIntent returned no row')

  return toIntent(data)
}

/**
 * Inserts an outbound message row into the shared messages table.
 * Outbound-messaging owns writes for direction='outbound' (DDC-001).
 * DDC-003: scoped to a single recipientId.
 */
export async function insertOutboundMessage(
  supabase: SupabaseClient,
  recipientId: string,
  body: string,
  providerMessageId: string,
): Promise<void> {
  const { error } = await supabase
    .from('messages')
    .insert({
      recipient_id:        recipientId,
      direction:           'outbound',
      body,
      has_image_attachment: false,
      provider_message_id: providerMessageId,
    })

  if (error) throw new InternalError(`insertOutboundMessage failed: ${error.message}`)
}

/**
 * Saves the provider message ID on a pending intent immediately after the send
 * succeeds, before any other steps. This is the crash-safety record — if the
 * job dies after the send but before markSendIntentDelivered, a retry will see
 * the providerMessageId already set and skip the send (AIC-003).
 */
export async function stampSendIntentProviderMessageId(
  supabase: SupabaseClient,
  idempotencyKey: string,
  providerMessageId: string,
): Promise<void> {
  const { error } = await supabase
    .from('outbound_send_intents')
    .update({
      provider_message_id: providerMessageId,
      updated_at:          new Date().toISOString(),
    })
    .eq('idempotency_key', idempotencyKey)

  if (error) throw new InternalError(`stampSendIntentProviderMessageId failed: ${error.message}`)
}

/**
 * Marks the send intent as delivered and records the provider message ID.
 */
export async function markSendIntentDelivered(
  supabase: SupabaseClient,
  idempotencyKey: string,
  providerMessageId: string,
): Promise<void> {
  const { error } = await supabase
    .from('outbound_send_intents')
    .update({
      status:              'delivered',
      provider_message_id: providerMessageId,
      updated_at:          new Date().toISOString(),
    })
    .eq('idempotency_key', idempotencyKey)

  if (error) throw new InternalError(`markSendIntentDelivered failed: ${error.message}`)
}
