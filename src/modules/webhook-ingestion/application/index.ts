import { getSupabaseClient } from '../../../platform/db-supabase/index.js'
import { ConflictError } from '../../../shared/errors/index.js'
import { existsWebhookEvent, insertWebhookEvent, markWebhookEventProcessed as markWebhookEventProcessedInDb } from '../data-access/index.js'
import type { WebhookEvent } from '../domain/index.js'
import type { NormalizedInboundEvent } from '../adapters/index.js'

// ── Job payload type (JOB-INBOUND-001) ───────────────────────────────────────
//
// Produced by the webhook route; consumed by the inbound-continuation worker.
// Exported here so the worker can import it without depending on platform internals.

export interface InboundContinuationJobPayload {
  webhookId:       string
  recipientHandle: string
  text:            string
  correlationId:   string
}

// ── Result type ───────────────────────────────────────────────────────────────

export type IngestResult =
  | { status: 'accepted'; event: WebhookEvent; normalized: NormalizedInboundEvent }
  | { status: 'duplicate' }
  | { status: 'skipped'; reason: string }

// ── Use case ──────────────────────────────────────────────────────────────────

// TODO: integration tests for ingestWebhookEvent (duplicate path, ConflictError race condition,
// skipped path) are missing — requires a live Supabase instance. Add in PH-01 env setup.

/**
 * Inbound webhook ingestion use case (AIC-001).
 *
 * Decision sequence:
 *   1. Non-message_inbound events → skipped (ACK without processing)
 *   2. Already-seen webhook_id    → duplicate (idempotent ACK)
 *   3. New event                  → insert idempotency record → accepted
 *
 * The caller (route handler) is responsible for enqueuing after 'accepted'.
 */

/**
 * Stamps processed_at = now() on the webhook_events row after successful enqueue.
 * Fire-and-forget from the route layer — errors are swallowed because the job
 * is already enqueued and the idempotency record is already committed.
 */
export async function markWebhookEventProcessed(webhookId: string): Promise<void> {
  const supabase = getSupabaseClient()
  await markWebhookEventProcessedInDb(supabase, webhookId)
}

export async function ingestWebhookEvent(
  normalized: NormalizedInboundEvent,
): Promise<IngestResult> {
  // Step 1: only process inbound messages; ACK everything else without side effects
  if (normalized.event !== 'message_inbound') {
    return { status: 'skipped', reason: `unhandled event type: ${normalized.event}` }
  }

  const supabase = getSupabaseClient()

  // Step 2: check for duplicate delivery
  const alreadySeen = await existsWebhookEvent(supabase, normalized.webhookId)
  if (alreadySeen) return { status: 'duplicate' }

  // Step 3: insert idempotency record; catch race-condition conflict
  try {
    const event = await insertWebhookEvent(supabase, normalized.webhookId)
    return { status: 'accepted', event, normalized }
  } catch (err) {
    if (err instanceof ConflictError) return { status: 'duplicate' }
    throw err
  }
}
