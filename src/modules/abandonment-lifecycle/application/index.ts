import { getSupabaseClient } from '../../../platform/db-supabase/index.js'
import { getQueue, QUEUE_NAMES } from '../../../platform/queue-bullmq/queues.js'
import { createLogger } from '../../../platform/observability/index.js'
import { pauseRecipient } from '../../identity-recipient/index.js'
import { findRecipientsForOutboundStop, findRecipientsForPurge } from '../data-access/index.js'

const log = createLogger({ module: 'abandonment-lifecycle' })

// ── 7-day outbound stop ───────────────────────────────────────────────────────

/**
 * Enforces the 7-day outbound stop rule (Q3.R3).
 *
 * Finds pre-goal recipients whose first_seen_at is more than 7 days ago and
 * sets globally_paused = true on each via identity-recipient's public API
 * (DDC-001 — single write-authority for E-RECIPIENT).
 *
 * Per-recipient errors are logged as warnings and do not abort the batch.
 * Called by the MAINTENANCE worker job handler (type: '7-day-stop').
 *
 * NOTE: paused recipients can still send inbound messages; only automated
 * proactive outbound is blocked (Q3.R3: "until they message again").
 * TODO: implement auto-resume when a paused recipient sends a new inbound message.
 */
export async function enforceOutboundStop(): Promise<void> {
  const supabase = getSupabaseClient()
  const recipients = await findRecipientsForOutboundStop(supabase)

  if (recipients.length === 0) {
    log.info({ event: 'abandonment.stop_run_complete', count: 0 })
    return
  }

  let paused = 0
  let failed = 0

  for (const recipient of recipients) {
    try {
      await pauseRecipient(recipient.id)
      // Never log handle — log internal id only (OAC-002)
      log.info({ event: 'abandonment.outbound_stopped', recipientId: recipient.id })
      paused++
    } catch (err) {
      log.warn({ event: 'abandonment.stop_failed', recipientId: recipient.id, err })
      failed++
    }
  }

  log.info({ event: 'abandonment.stop_run_complete', paused, failed })
}

// ── 90-day pre-goal purge ─────────────────────────────────────────────────────

/**
 * Enqueues JOB-DELETE-001 for each recipient eligible for the 90-day pre-goal
 * purge (Q3.R3).
 *
 * Eligibility: no goal, first_seen_at > 90 days ago, no inbound message in the
 * last 90 days (resolved-architecture-intake §15: "any inbound message").
 *
 * Uses jobId = 'delete:<recipientId>' so the enqueue deduplicates with any
 * concurrent manual delete request from user-rights-ops (AIC-003).
 *
 * Per-recipient enqueue errors are swallowed — un-enqueued recipients are
 * caught by the next day's run. Called by the MAINTENANCE job handler (type: '90-day-purge').
 */
export async function enqueuePreGoalPurges(): Promise<void> {
  const supabase = getSupabaseClient()
  const recipients = await findRecipientsForPurge(supabase)

  if (recipients.length === 0) {
    log.info({ event: 'abandonment.purge_run_complete', enqueued: 0 })
    return
  }

  let enqueued = 0
  let failed   = 0

  for (const recipient of recipients) {
    try {
      await getQueue(QUEUE_NAMES.DELETE_FULFILLMENT).add(
        'delete-fulfillment',
        {
          recipientId:   recipient.id,
          correlationId: `purge:${recipient.id}`,
          requestedAt:   new Date().toISOString(),
        },
        {
          // Deterministic jobId deduplicates with any in-flight manual delete (AIC-003)
          jobId:    `delete:${recipient.id}`,
          attempts: 5,
          backoff:  { type: 'exponential', delay: 5000 },
        },
      )
      log.info({ event: 'abandonment.purge_enqueued', recipientId: recipient.id })
      enqueued++
    } catch (err) {
      // One failed enqueue must not abort the batch — retry tomorrow
      log.warn({ event: 'abandonment.purge_enqueue_failed', recipientId: recipient.id, err })
      failed++
    }
  }

  log.info({ event: 'abandonment.purge_run_complete', enqueued, failed })
}
