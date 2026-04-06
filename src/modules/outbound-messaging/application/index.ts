import { getSupabaseClient } from '../../../platform/db-supabase/index.js'
import { sendMessage } from '../adapters/index.js'
import { findSendIntent, insertSendIntent, insertOutboundMessage, stampSendIntentProviderMessageId, markSendIntentDelivered } from '../data-access/index.js'

/**
 * Sends an outbound iMessage reply with full idempotency protection (AIC-003).
 *
 * Flow:
 *   1. Check for an existing delivered send intent — skip if already sent (retry-safe)
 *   2. Insert a pending intent row (idempotency record)
 *   3. If providerMessageId already stamped, send already happened — skip to step 5
 *   4. Call LoopMessage sendMessage API; immediately stamp providerMessageId (crash-safety)
 *   5. Save outbound message to conversation history (E-MESSAGE)
 *   6. Mark intent as delivered
 *
 * Content (body) is never passed to the logger (OAC-002).
 * All DB queries are scoped to recipientId (DDC-003).
 */
export async function sendOutboundMessage(
  recipientId: string,
  handle: string,
  body: string,
  idempotencyKey: string,
  correlationId?: string,
): Promise<void> {
  const supabase = getSupabaseClient()

  // Step 1: idempotent retry guard — already delivered, nothing to do
  const existing = await findSendIntent(supabase, idempotencyKey)
  if (existing?.status === 'delivered') return

  // Step 2: record pending intent (if not already recorded from a prior partial attempt)
  if (!existing) {
    await insertSendIntent(supabase, recipientId, idempotencyKey)
  }

  // Step 3: if providerMessageId already saved, send already happened — skip the API call
  let providerMessageId = existing?.providerMessageId ?? null
  if (!providerMessageId) {
    // Step 4: call LoopMessage — throws ServiceUnavailableError on failure so job retries
    providerMessageId = await sendMessage(handle, body, correlationId)
    // Immediately stamp the providerMessageId so a crash here won't cause a duplicate send
    await stampSendIntentProviderMessageId(supabase, idempotencyKey, providerMessageId)
  }

  // Step 5: save outbound message to conversation history
  await insertOutboundMessage(supabase, recipientId, body, providerMessageId)

  // Step 6: mark intent delivered
  await markSendIntentDelivered(supabase, idempotencyKey, providerMessageId)
}
