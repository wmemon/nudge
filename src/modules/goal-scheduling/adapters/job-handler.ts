// JOB-SCHED-001 consumer — scheduled check-in job handler.
// Lives in adapters/ because it is the async boundary adapter for BullMQ.

import { type Job } from 'bullmq'
import { z } from 'zod'
import { config } from '../../../platform/config/index.js'
import { createLogger } from '../../../platform/observability/index.js'
import { findRecipientById } from '../../identity-recipient/index.js'
import { sendOutboundMessage } from '../../outbound-messaging/index.js'
import {
  MISSED_WINDOW_THRESHOLD_MINUTES,
  scheduleNextCheckin,
  recordMissedWindow,
  getScheduleForRecipient,
} from '../application/index.js'
import {
  checkCanSendProactive,
  recordProactiveSent,
} from '../../proactive-policy/index.js'
import { incrementCheckinCount } from '../../usage-metering/index.js'

const log = createLogger({ module: 'scheduled-checkin-handler' })

// ── Payload schema (VID-001) ──────────────────────────────────────────────────

const ScheduledCheckinPayloadSchema = z.object({
  recipientId:   z.string().uuid(),
  scheduledAt:   z.string().datetime(),
  correlationId: z.string(),
})

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * BullMQ consumer for JOB-SCHED-001 — scheduled proactive check-in.
 *
 * Flow:
 *   1. Validate payload (VID-001)
 *   2. Missed-window check — job fired too late → record missed + reschedule, no send (Q12.3)
 *   3. Proactive sends toggle — disabled → reschedule, no send (ADR §13)
 *   4. Load schedule — paused → record missed + reschedule, no send (Q3.2)
 *   4b. Proactive policy gate — cap or spacing blocked → reschedule, no send (ADR §13)
 *   5. Load recipient for handle (needed to address the outbound message)
 *   6. Send check-in message with idempotency key (AIC-003)
 *   6b. Record proactive send on scoreboard (ADR §13)
 *   7. Schedule the next check-in
 *
 * Content is never logged (OAC-002).
 */
export async function handleScheduledCheckinJob(job: Job): Promise<void> {
  // Step 1: validate payload at job boundary — invalid jobs fail immediately, no retry
  const payload = ScheduledCheckinPayloadSchema.parse(job.data)
  const { recipientId, scheduledAt, correlationId } = payload

  log.info({ event: 'job.started', jobId: job.id, queue: 'scheduled-checkin', correlationId })

  const scheduledAtDate = new Date(scheduledAt)

  // Step 2: missed-window check (Q12.3)
  const latenessMs = Date.now() - scheduledAtDate.getTime()
  if (latenessMs > MISSED_WINDOW_THRESHOLD_MINUTES * 60_000) {
    log.warn({ event: 'job.missed_window', jobId: job.id, correlationId, latenessMs })
    await recordMissedWindow(recipientId, scheduledAtDate, 'downtime')
    await scheduleNextCheckin(recipientId)
    return
  }

  // Step 3: proactive sends toggle (ADR §13, config hard-override per DPC-001)
  if (!config.PROACTIVE_SENDS_ENABLED) {
    log.info({ event: 'job.proactive_disabled', jobId: job.id, correlationId })
    await scheduleNextCheckin(recipientId)
    return
  }

  // Step 4: load schedule — skip if paused or snoozed
  const schedule = await getScheduleForRecipient(recipientId)

  if (!schedule) {
    // Schedule was removed (e.g. account deleted in flight) — nothing to do
    log.warn({ event: 'job.no_schedule', jobId: job.id, correlationId })
    return
  }

  if (schedule.paused) {
    log.info({ event: 'job.schedule_paused', jobId: job.id, correlationId })
    await recordMissedWindow(recipientId, scheduledAtDate, 'paused')
    await scheduleNextCheckin(recipientId)
    return
  }

  if (schedule.snoozeUntil && schedule.snoozeUntil > new Date()) {
    log.info({ event: 'job.schedule_snoozed', jobId: job.id, correlationId })
    await scheduleNextCheckin(recipientId)
    return
  }

  // Step 4b: proactive policy gate — rolling 24h cap + minimum spacing (ADR §13)
  const policy = await checkCanSendProactive(recipientId)
  if (!policy.allowed) {
    log.info({ event: 'job.proactive_gated', jobId: job.id, correlationId, reason: policy.reason })
    await scheduleNextCheckin(recipientId)
    return
  }

  // Step 5: load recipient to get handle (required for outbound addressing)
  const recipient = await findRecipientById(recipientId)
  if (!recipient) {
    log.warn({ event: 'job.recipient_not_found', jobId: job.id, correlationId })
    return
  }

  // Step 5b: allowlist guard — non-production only (DPC-004)
  if (config.NODE_ENV !== 'production' && config.NODE_ENV !== 'test') {
    const allowlist = config.LOOPMESSAGE_ALLOWLIST
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)

    if (allowlist.length > 0 && !allowlist.includes(recipient.handle)) {
      log.warn({ event: 'job.allowlist_blocked', jobId: job.id, correlationId })
      return
    }
  }

  // Step 6: send check-in message
  // Idempotency key ties this send to the scheduled window — retries are no-ops (AIC-003)
  const idempotencyKey = `checkin:${recipientId}:${scheduledAt}`
  const message = "Hey! Just checking in on your goal — how's it going today? 💪"

  // TODO: replace with LLM-personalised message referencing recipient's goal text (post-MVP)

  await sendOutboundMessage(
    recipient.id,
    recipient.handle,
    message,
    idempotencyKey,
    correlationId,
  )

  log.info({ event: 'job.checkin_sent', jobId: job.id, correlationId })

  // Step 6b: update proactive policy scoreboard (ADR §13)
  await recordProactiveSent(recipientId)

  // Fire-and-forget: increment usage counter — a counter failure must never abort the send (Q1.R1)
  incrementCheckinCount(recipientId).catch((err: unknown) => {
    log.warn({ event: 'usage.increment_failed', metric: 'checkins_completed', recipientId, err })
  })

  // Step 7: schedule the next check-in
  await scheduleNextCheckin(recipientId)

  log.info({ event: 'job.completed', jobId: job.id, queue: 'scheduled-checkin', correlationId })
}
