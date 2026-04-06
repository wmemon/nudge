import { createHash } from 'node:crypto'
import type { Job } from 'bullmq'
import { getQueue, QUEUE_NAMES } from '../../../platform/queue-bullmq/queues.js'
import { getSupabaseClient } from '../../../platform/db-supabase/index.js'
import { uploadObject, generatePresignedGetUrl, deleteObjects } from '../../../platform/storage-s3/index.js'
import { sendMessage } from '../../../platform/loopmessage-adapter/index.js'
import { config } from '../../../platform/config/index.js'
import { createLogger } from '../../../platform/observability/index.js'
import { ServiceUnavailableError } from '../../../shared/errors/index.js'
import { z, parseOrThrow } from '../../../shared/validation/index.js'
import { verifyRightsToken, revokeSession } from '../../otp-verification/index.js'
import { findRecipientById } from '../../identity-recipient/index.js'
import { getScheduleForRecipient } from '../../goal-scheduling/index.js'
import {
  computeExportSlaDeadline,
  generateExportS3Key,
  EXPORT_STATUS,
  DELETE_STATUS,
  type ExportBundle,
} from '../domain/index.js'
import {
  findActiveExportJob,
  createExportJob,
  updateExportJobStatus,
  createExportArtifact,
  fetchExportBundleData,
  findDeleteJob,
  createDeleteJob,
  updateDeleteJobStatus,
  fetchExportArtifactsByRecipient,
  deleteRecipientById,
} from '../data-access/index.js'

const log = createLogger({ module: 'user-rights-ops' })

// ── Enqueue export ────────────────────────────────────────────────────────────

export interface EnqueueResult {
  referenceId: string
}

/**
 * Validates the bearer token and enqueues an export fulfillment job (API-RIGHTS-001).
 *
 * Flow:
 *   1. Verify token has 'export' capability — throws UnauthorizedError on failure
 *   2. Enqueue JOB-EXPORT-001 — jobId deduplicates concurrent requests for same recipient
 *   3. Return referenceId for support/diagnostics
 *
 * The job payload is intentionally minimal — no sensitive content (OAC-002).
 */
export async function enqueueExport(params: {
  rawToken:      string
  correlationId: string
}): Promise<EnqueueResult> {
  const { recipientId } = await verifyRightsToken(params.rawToken, 'export')

  const jobId = `export:${recipientId}`

  try {
    await getQueue(QUEUE_NAMES.EXPORT_FULFILLMENT).add(
      'export-fulfillment',
      {
        recipientId,
        correlationId: params.correlationId,
        requestedAt:   new Date().toISOString(),
      },
      {
        jobId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
      },
    )
  } catch (err) {
    log.error({ event: 'rights.export.enqueue_failed', correlationId: params.correlationId, recipientId, err })
    throw new ServiceUnavailableError('Failed to enqueue export — please try again')
  }

  log.info({ event: 'rights.export.enqueued', correlationId: params.correlationId, jobId })
  return { referenceId: jobId }
}

// ── Enqueue delete ────────────────────────────────────────────────────────────

/**
 * Validates the bearer token and enqueues an account deletion job (API-RIGHTS-002).
 *
 * Flow:
 *   1. Verify token has 'delete' capability — throws UnauthorizedError on failure
 *   2. Enqueue JOB-DELETE-001 — jobId deduplicates concurrent requests for same recipient
 *   3. Revoke the rights session so the same token cannot trigger delete again
 *   4. Return referenceId for support/diagnostics
 *
 * Revocation happens after enqueue — if revocation fails the job is still enqueued
 * and the deletion proceeds. The delete saga is idempotent so a retry from the same
 * token (before it expires) would produce a duplicate jobId no-op in BullMQ.
 */
export async function enqueueDelete(params: {
  rawToken:      string
  correlationId: string
}): Promise<EnqueueResult> {
  const { recipientId, sessionId } = await verifyRightsToken(params.rawToken, 'delete')

  const jobId = `delete:${recipientId}`

  try {
    await getQueue(QUEUE_NAMES.DELETE_FULFILLMENT).add(
      'delete-fulfillment',
      {
        recipientId,
        correlationId: params.correlationId,
        requestedAt:   new Date().toISOString(),
      },
      {
        jobId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
      },
    )
  } catch (err) {
    log.error({ event: 'rights.delete.enqueue_failed', correlationId: params.correlationId, recipientId, err })
    throw new ServiceUnavailableError('Failed to enqueue deletion — please try again')
  }

  // Revoke session after enqueue — best-effort; log but do not fail the request
  revokeSession(sessionId).catch((err) => {
    log.warn({ event: 'rights.delete.revoke_failed', correlationId: params.correlationId, sessionId, err })
  })

  log.info({ event: 'rights.delete.enqueued', correlationId: params.correlationId, jobId })
  return { referenceId: jobId }
}

// ── Export fulfillment ────────────────────────────────────────────────────────

const ExportJobPayloadSchema = z.object({
  recipientId:   z.string().uuid(),
  correlationId: z.string().min(1),
  requestedAt:   z.string().datetime(),
})

/**
 * Fulfills an export job end-to-end (JOB-EXPORT-001).
 *
 * Called by the worker consumer for QUEUE_NAMES.EXPORT_FULFILLMENT.
 * Safe to retry: each step is idempotent or guarded by a status check.
 *
 * Saga steps:
 *   1. Validate job payload — non-retriable ValidationError goes straight to DLQ
 *   2. Find or create the Postgres export job row
 *   3. Idempotency guard — return early if already delivered
 *   4. Transition status: queued → building (skip if already building on retry)
 *   5. Fetch message history, active goal, and schedule from Postgres (Q6.R2)
 *   6. Serialize bundle to JSON; compute sha256 content hash
 *   7. Upload bundle to S3 under the exports/ prefix (PutObject is idempotent by key)
 *   8. Record artifact metadata in Postgres (export_artifacts)
 *   9. Generate presigned GET URL (24h TTL) — never logged (OAC-002)
 *  10. Send iMessage with download link
 *  11. Transition status: building → delivered
 *
 * On any error: stamp status → failed with a brief reason, then re-throw so
 * BullMQ retries the job. After exhausting retries the job moves to the failed
 * queue for DLQ runbook handling (OAC-003).
 *
 * Known MVP edge case: if step 10 (iMessage send) succeeds but step 11 (DB
 * update) fails, a retry will re-send the delivery message. Accepted because
 * LoopMessage has no server-side idempotency key and this scenario is very rare.
 */
export async function fulfillExport(job: Job): Promise<void> {
  const jobLog = createLogger({ module: 'user-rights-ops', bullmqJobId: job.id })

  // ── Step 1: Validate payload ─────────────────────────────────────────────────
  // parseOrThrow throws ValidationError (non-retriable) on bad data so BullMQ
  // moves it to the failed queue immediately without burning retry attempts.
  const { recipientId, correlationId, requestedAt } = parseOrThrow(
    ExportJobPayloadSchema,
    job.data,
  )

  jobLog.info({ event: 'export.job.started', recipientId, correlationId })

  const supabase = getSupabaseClient()

  // ── Step 2: Find or create the Postgres export job row ───────────────────────
  let exportJob = await findActiveExportJob(supabase, recipientId)

  // ── Step 3: Idempotency guard ────────────────────────────────────────────────
  if (exportJob?.status === EXPORT_STATUS.DELIVERED) {
    jobLog.info({ event: 'export.job.already_delivered', exportJobId: exportJob.id, recipientId })
    return
  }

  if (!exportJob) {
    const slaDeadlineAt = computeExportSlaDeadline(new Date(requestedAt))
    exportJob = await createExportJob(supabase, { recipientId, correlationId, slaDeadlineAt })
  }

  const exportJobId = exportJob.id

  // Track current DB status locally so the error handler uses the right `from` value.
  let currentStatus = exportJob.status

  try {
    // ── Step 4: Transition to building ─────────────────────────────────────────
    // Skip if already building — this is a retry resuming mid-flight.
    if (currentStatus === EXPORT_STATUS.QUEUED) {
      await updateExportJobStatus(supabase, exportJobId, EXPORT_STATUS.QUEUED, EXPORT_STATUS.BUILDING)
      currentStatus = EXPORT_STATUS.BUILDING
    }

    // ── Step 5: Fetch bundle data ───────────────────────────────────────────────
    const bundleData = await fetchExportBundleData(supabase, recipientId)

    // ── Step 6: Build bundle JSON ───────────────────────────────────────────────
    const bundle: ExportBundle = {
      generatedAt: new Date().toISOString(),
      messages:    bundleData.messages,
      goal:        bundleData.goal,
      schedule:    bundleData.schedule,
    }
    const buffer      = Buffer.from(JSON.stringify(bundle, null, 2), 'utf8')
    const contentHash = createHash('sha256').update(buffer).digest('hex')

    // ── Step 7: Upload to S3 ────────────────────────────────────────────────────
    // PutObject is idempotent by key — safe to repeat on retry.
    const s3Key = generateExportS3Key({
      prefix:      config.S3_PREFIX_EXPORTS,
      recipientId,
      jobId:       exportJobId,
    })

    const { sizeBytes } = await uploadObject({
      key:         s3Key,
      body:        buffer,
      contentType: 'application/json',
    })

    // Log the key only — never the buffer content or presigned URL (OAC-002)
    jobLog.info({ event: 'export.artifact.uploaded', exportJobId, s3Key })

    // ── Step 8: Record artifact ─────────────────────────────────────────────────
    // On a retry where upload already succeeded, this creates a duplicate row.
    // Both rows share the same s3_key so S3 deletion on account deletion is safe
    // (deleting a key twice is a no-op from S3's perspective).
    await createExportArtifact(supabase, {
      exportJobId,
      recipientId,
      s3Key,
      sizeBytes,
      contentHash,
    })

    // ── Step 9: Generate presigned URL ──────────────────────────────────────────
    // NEVER pass this value to any logger, error, or Sentry context (OAC-002).
    const presignedUrl = await generatePresignedGetUrl(s3Key)

    // ── Step 10: Send iMessage ──────────────────────────────────────────────────
    // TODO: move message copy to config for easier tuning post-MVP.
    const recipient = await findRecipientById(recipientId)
    if (!recipient) throw new Error(`Recipient not found: ${recipientId}`)

    const messageBody =
      `Your data export is ready. ` +
      `You can download it here (link expires in 24 hours): ${presignedUrl}`

    await sendMessage(recipient.handle, messageBody)

    // ── Step 11: Transition to delivered ───────────────────────────────────────
    await updateExportJobStatus(
      supabase,
      exportJobId,
      EXPORT_STATUS.BUILDING,
      EXPORT_STATUS.DELIVERED,
      { deliveredAt: new Date() },
    )

    jobLog.info({ event: 'export.job.delivered', exportJobId, recipientId })

  } catch (err) {
    // Best-effort: stamp the job failed so the DLQ runbook has a clear signal.
    // If this secondary update throws, swallow it and let the original error propagate.
    const reason = err instanceof Error ? err.message : String(err)
    await updateExportJobStatus(
      supabase,
      exportJobId,
      currentStatus,
      EXPORT_STATUS.FAILED,
      { failedAt: new Date(), failureReason: reason.slice(0, 500) },
    ).catch((updateErr: unknown) => {
      jobLog.warn({ event: 'export.job.failed_status_update_error', exportJobId, updateErr })
    })

    jobLog.error({ event: 'export.job.failed', exportJobId, recipientId, err })
    throw err  // re-throw so BullMQ retries / moves to DLQ after exhaustion
  }
}

// ── Delete fulfillment ────────────────────────────────────────────────────────

const DeleteJobPayloadSchema = z.object({
  recipientId:   z.string().uuid(),
  correlationId: z.string().min(1),
  requestedAt:   z.string().datetime(),
})

/**
 * Fulfills an account deletion job end-to-end (JOB-DELETE-001).
 *
 * Called by the worker consumer for QUEUE_NAMES.DELETE_FULFILLMENT.
 * Safe to retry: each step is idempotent or guarded by a status/existence check.
 *
 * Saga steps:
 *   0. Validate job payload — non-retriable ValidationError goes straight to DLQ
 *   1. Idempotency guard — return early if recipient no longer exists (already deleted)
 *   2. Find or create the delete_jobs tracking row
 *   3. Transition to executing (skip if already executing — retry resuming mid-flight)
 *   4. Collect S3 keys from export_artifacts BEFORE any Postgres deletes
 *   5. Best-effort BullMQ job cancellation (export + scheduled check-in)
 *   6. Delete S3 objects (best-effort — per-key errors are logged and swallowed)
 *   7. Emit audit log event — must fire BEFORE the irreversible DELETE (OAC-003)
 *   8. Delete recipient row — cascades all dependent Postgres tables and the
 *      delete_jobs row itself
 *
 * On any error (steps 4–8): stamp delete_jobs status → failed with brief reason,
 * then re-throw so BullMQ retries. After exhausting retries the job moves to the
 * failed queue for DLQ runbook handling (OAC-003).
 *
 * // TODO: optionally send a deletion-confirmation iMessage before step 8
 * //       (nice-to-have per resolved-architecture-intake §16; deferred for MVP)
 */
export async function fulfillDelete(job: Job): Promise<void> {
  const jobLog = createLogger({ module: 'user-rights-ops', bullmqJobId: job.id })

  // ── Step 0: Validate payload ──────────────────────────────────────────────────
  const { recipientId, correlationId } = parseOrThrow(DeleteJobPayloadSchema, job.data)

  jobLog.info({ event: 'delete.job.started', recipientId, correlationId })

  const supabase = getSupabaseClient()

  // ── Step 1: Idempotency guard ─────────────────────────────────────────────────
  // If the recipient is already gone, deletion completed on a prior attempt.
  const recipient = await findRecipientById(recipientId)
  if (!recipient) {
    jobLog.info({ event: 'delete.job.recipient_already_gone', recipientId, correlationId })
    return
  }

  // ── Step 2: Find or create delete_jobs tracking row ──────────────────────────
  let deleteJob = await findDeleteJob(supabase, recipientId)
  if (!deleteJob) {
    deleteJob = await createDeleteJob(supabase, { recipientId, correlationId })
  }

  const deleteJobId = deleteJob.id

  try {
    // ── Step 3: Transition to executing ────────────────────────────────────────
    // Skip if already executing — this is a retry resuming mid-flight.
    // Inside try so any DB failure is caught, logged, and stamped as FAILED.
    if (deleteJob.status === DELETE_STATUS.PENDING || deleteJob.status === DELETE_STATUS.FAILED) {
      await updateDeleteJobStatus(supabase, deleteJobId, deleteJob.status, DELETE_STATUS.EXECUTING)
    }

    // ── Step 4: Collect S3 keys — MUST happen before any Postgres deletes ────────
    // The cascade on export_artifacts makes S3 keys unrecoverable after the
    // recipient DELETE (see migration 20260403000001 comment).
    const s3Keys = await fetchExportArtifactsByRecipient(supabase, recipientId)

    // ── Step 5: Best-effort BullMQ job cancellation ───────────────────────────────
    // Errors are swallowed — jobs that slip through handle a missing recipient
    // gracefully (schedule/recipient null-checks in their handlers).

    // Cancel any in-queue export fulfillment job for this recipient
    await getQueue(QUEUE_NAMES.EXPORT_FULFILLMENT)
      .remove(`export:${recipientId}`)
      .catch((err: unknown) => {
        jobLog.warn({ event: 'delete.job.cancel_export_failed', recipientId, err })
      })

    // Cancel the pending scheduled check-in job (job id is deterministic from next_run_at)
    const schedule = await getScheduleForRecipient(recipientId)
    if (schedule?.nextRunAt) {
      const checkinJobId = `checkin:${recipientId}:${schedule.nextRunAt.toISOString()}`
      await getQueue(QUEUE_NAMES.SCHEDULED_CHECKIN)
        .remove(checkinJobId)
        .catch((err: unknown) => {
          jobLog.warn({ event: 'delete.job.cancel_checkin_failed', recipientId, err })
        })
    }

    // ── Step 6: Delete S3 objects ─────────────────────────────────────────────────
    // deleteObjects swallows per-key errors internally — partial S3 cleanup must
    // not block the Postgres cascade that removes the user's data.
    await deleteObjects(s3Keys)

    // ── Step 7: Audit log — fires BEFORE the irreversible DELETE (OAC-003) ────────
    // This is the durable audit record. If the process crashes between this log
    // and step 8, a retry will re-run from step 1 (recipient still exists) and
    // complete the deletion; the audit log will appear twice, which is acceptable.
    jobLog.info({
      event:          'delete.job.completed',
      recipientId,
      correlationId,
      s3KeysDeleted:  s3Keys.length,
    })

    // ── Step 8: Delete recipient — cascades all dependent Postgres tables ─────────
    // Cascades: messages, nlu_outcomes, outbound_send_intents, goals, schedules,
    // missed_windows, proactive_policy_state, otp_sessions, rights_sessions,
    // export_jobs, export_artifacts, delete_jobs (this row included).
    await deleteRecipientById(supabase, recipientId)

  } catch (err) {
    // Best-effort: stamp the delete job failed so the DLQ runbook has a clear signal.
    // If this secondary update throws (e.g. the row was already cascaded), swallow it.
    const reason = err instanceof Error ? err.message : String(err)
    await updateDeleteJobStatus(
      supabase,
      deleteJobId,
      DELETE_STATUS.EXECUTING,
      DELETE_STATUS.FAILED,
      { failureReason: reason.slice(0, 500) },
    ).catch((updateErr: unknown) => {
      jobLog.warn({ event: 'delete.job.failed_status_update_error', deleteJobId, updateErr })
    })

    jobLog.error({ event: 'delete.job.failed', deleteJobId, recipientId, err })
    throw err  // re-throw so BullMQ retries / moves to DLQ after exhaustion
  }
}
