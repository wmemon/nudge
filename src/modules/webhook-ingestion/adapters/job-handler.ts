// JOB-INBOUND-001 consumer — inbound continuation job handler.
// Lives in adapters/ because it is the async boundary adapter for BullMQ,
// parallel to how HTTP route handlers are in app/routes/.

import { type Job } from 'bullmq'
import { z } from 'zod'
import { config } from '../../../platform/config/index.js'
import { createLLMRouter } from '../../../platform/llm-router/index.js'
import { createLogger } from '../../../platform/observability/index.js'
import { findOrCreateRecipient, markOnboardingComplete } from '../../identity-recipient/index.js'
import { processInboundTurn, getConversationHistory } from '../../conversation-accountability/index.js'
import { sendOutboundMessage } from '../../outbound-messaging/index.js'
import { captureGoal, getActiveGoal } from '../../goal-scheduling/index.js'
import { recordInboundReply } from '../../proactive-policy/index.js'

const log = createLogger({ module: 'inbound-continuation-handler' })

// ── Payload schema (VID-001) ──────────────────────────────────────────────────

const InboundContinuationPayloadSchema = z.object({
  webhookId:       z.string(),
  recipientHandle: z.string(),
  text:            z.string(),
  correlationId:   z.string(),
})

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * BullMQ consumer for JOB-INBOUND-001 — inbound message continuation.
 *
 * Flow:
 *   1. Validate payload (VID-001) — invalid jobs fail immediately, no retry
 *   2. Allowlist guard in non-production (DPC-004)
 *   3. Resolve recipient (E-RECIPIENT)
 *   4. Check active goal — determines onboarding vs accountability mode
 *   5. Skip LLM if toggle is off (LLM_CALLS_ENABLED=false)
 *   6. Get conversation history
 *   7a. ONBOARDING (no goal): call completeOnboarding(); if goal detected,
 *       persist goal + schedule + mark onboarding complete
 *   7b. ACCOUNTABILITY (has goal): call complete(); standard accountability path
 *   8. Persist inbound message + NLU outcome (E-MESSAGE, E-NLU-OUTCOME)
 *   9. Send outbound reply with idempotency key (AIC-003)
 *
 * Content (text, reply) is never logged (OAC-002).
 */
export async function handleInboundContinuation(job: Job): Promise<void> {
  // Step 1: validate payload at job boundary
  const payload = InboundContinuationPayloadSchema.parse(job.data)
  const { webhookId, recipientHandle, text, correlationId } = payload

  // Log identity fields only — never log recipientHandle or text (OAC-002)
  log.info({ event: 'job.started', jobId: job.id, queue: 'inbound-continuation', correlationId })

  // Step 2: allowlist guard — non-production only (DPC-004)
  if (config.NODE_ENV !== 'production' && config.NODE_ENV !== 'test') {
    const allowlist = config.LOOPMESSAGE_ALLOWLIST
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)

    if (allowlist.length > 0 && !allowlist.includes(recipientHandle)) {
      log.warn({ event: 'job.allowlist_blocked', jobId: job.id, correlationId })
      return
    }
  }

  // Step 3: resolve recipient
  const recipient = await findOrCreateRecipient(recipientHandle)

  // Step 4: check active goal — determines which LLM mode to use
  const activeGoal = await getActiveGoal(recipient.id)

  // Step 5: skip LLM if toggle is off
  if (!config.LLM_CALLS_ENABLED) {
    log.info({ event: 'job.llm_disabled', jobId: job.id, correlationId })
    return
  }

  // Step 6: get conversation history (same for both modes)
  const history = await getConversationHistory(recipient.id)
  const router  = createLLMRouter()

  let llmResponse: Awaited<ReturnType<typeof router.complete>>

  if (!activeGoal) {
    // ── Step 7a: ONBOARDING MODE ─────────────────────────────────────────────
    // No active goal — guide the user through setting one.
    const onboardingResponse = await router.completeOnboarding({
      messages: [...history, { role: 'user', content: text }],
      correlationId,
    })

    // Adapt to the shared LLMResponse shape for processInboundTurn below
    llmResponse = {
      content:    onboardingResponse.content,
      nluOutcome: onboardingResponse.nluOutcome,
      usage:      onboardingResponse.usage,
    }

    // If the LLM captured a goal + schedule, persist them now
    if (onboardingResponse.goalCapture.detected) {
      await captureGoal(recipient.id, {
        goalText:    onboardingResponse.goalCapture.goalText,
        checkInTime: onboardingResponse.goalCapture.checkInTime,
        timezone:    onboardingResponse.goalCapture.timezone,
      })
      await markOnboardingComplete(recipient.id)
      log.info({ event: 'job.goal_captured', jobId: job.id, correlationId })
    }
  } else {
    // ── Step 7b: ACCOUNTABILITY MODE ─────────────────────────────────────────
    // Active goal exists — standard accountability check-in response.
    llmResponse = await router.complete({
      messages: [...history, { role: 'user', content: text }],
      correlationId,
    })
  }

  // Step 8: persist inbound message + NLU outcome (same for both modes)
  await processInboundTurn(recipient.id, text, llmResponse)

  // Step 9: send outbound reply — idempotency key ties reply to this webhook delivery
  const idempotencyKey = `${webhookId}:reply`
  await sendOutboundMessage(recipient.id, recipientHandle, llmResponse.content, idempotencyKey, correlationId)

  // Step 10: count this inbound message as a reply on the proactive policy scoreboard (ADR §13)
  await recordInboundReply(recipient.id)

  log.info({ event: 'job.completed', jobId: job.id, queue: 'inbound-continuation', correlationId })
}
