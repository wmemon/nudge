import type { SupabaseClient } from '../../../platform/db-supabase/index.js'
import { InternalError } from '../../../shared/errors/index.js'
import {
  assertExportTransition,
  assertDeleteTransition,
  type ExportStatus,
  type DeleteStatus,
  type ExportMessage,
  type ExportGoal,
  type ExportSchedule,
} from '../domain/index.js'

// ── Export job entity ─────────────────────────────────────────────────────────

/** Postgres row shape for an export_jobs record. */
export interface ExportJob {
  id:             string
  recipientId:    string
  status:         ExportStatus
  correlationId:  string
  slaDeadlineAt:  Date
  createdAt:      Date
  updatedAt:      Date
  deliveredAt:    Date | null
  failedAt:       Date | null
  failureReason:  string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toExportJob(row: Record<string, any>): ExportJob {
  return {
    id:            row.id             as string,
    recipientId:   row.recipient_id   as string,
    status:        row.status         as ExportStatus,
    correlationId: row.correlation_id as string,
    slaDeadlineAt: new Date(row.sla_deadline_at as string),
    createdAt:     new Date(row.created_at      as string),
    updatedAt:     new Date(row.updated_at      as string),
    deliveredAt:   row.delivered_at ? new Date(row.delivered_at as string) : null,
    failedAt:      row.failed_at    ? new Date(row.failed_at    as string) : null,
    failureReason: row.failure_reason as string | null,
  }
}

// ── Export job repository ─────────────────────────────────────────────────────

/**
 * Returns the most recent non-failed export job for a recipient, or null.
 * Used by the application layer to detect in-progress or already-delivered
 * jobs before creating a new one (retry idempotency).
 * DDC-003: scoped to a single recipientId.
 */
export async function findActiveExportJob(
  supabase: SupabaseClient,
  recipientId: string,
): Promise<ExportJob | null> {
  const { data, error } = await supabase
    .from('export_jobs')
    .select('*')
    .eq('recipient_id', recipientId)
    .neq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new InternalError(`findActiveExportJob failed: ${error.message}`)
  return data ? toExportJob(data) : null
}

/**
 * Inserts a new export job row with status 'queued' and returns the created record.
 * The application layer should call findActiveExportJob first to avoid creating
 * a duplicate row on retry.
 * DDC-003: scoped to a single recipientId.
 */
export async function createExportJob(
  supabase: SupabaseClient,
  params: {
    recipientId:   string
    correlationId: string
    slaDeadlineAt: Date
  },
): Promise<ExportJob> {
  const { data, error } = await supabase
    .from('export_jobs')
    .insert({
      recipient_id:   params.recipientId,
      status:         'queued',
      correlation_id: params.correlationId,
      sla_deadline_at: params.slaDeadlineAt.toISOString(),
    })
    .select('*')
    .single()

  if (error) throw new InternalError(`createExportJob failed: ${error.message}`)
  if (!data)  throw new InternalError('createExportJob returned no row')

  return toExportJob(data)
}

/**
 * Advances the export job status from `from` to `to` after asserting the
 * transition is legal. Optionally stamps deliveredAt, failedAt, or failureReason.
 * DDC-001: this is the sole write path for export job status.
 */
export async function updateExportJobStatus(
  supabase: SupabaseClient,
  jobId: string,
  from: ExportStatus,
  to: ExportStatus,
  extras?: {
    deliveredAt?:   Date
    failedAt?:      Date
    failureReason?: string
  },
): Promise<void> {
  // Domain guard — throws on illegal transition before touching the DB.
  assertExportTransition(from, to)

  const patch: Record<string, unknown> = {
    status:     to,
    updated_at: new Date().toISOString(),
  }
  if (extras?.deliveredAt)   patch.delivered_at   = extras.deliveredAt.toISOString()
  if (extras?.failedAt)      patch.failed_at      = extras.failedAt.toISOString()
  if (extras?.failureReason) patch.failure_reason = extras.failureReason

  const { error } = await supabase
    .from('export_jobs')
    .update(patch)
    .eq('id', jobId)

  if (error) throw new InternalError(`updateExportJobStatus failed: ${error.message}`)
}

// ── Export artifact repository ────────────────────────────────────────────────

/**
 * Records metadata for an export bundle uploaded to S3.
 * One artifact per successful export job.
 * DDC-003: scoped to a single recipientId.
 */
export async function createExportArtifact(
  supabase: SupabaseClient,
  params: {
    exportJobId:  string
    recipientId:  string
    s3Key:        string
    sizeBytes?:   number
    contentHash?: string
  },
): Promise<void> {
  const { error } = await supabase
    .from('export_artifacts')
    .insert({
      export_job_id: params.exportJobId,
      recipient_id:  params.recipientId,
      s3_key:        params.s3Key,
      size_bytes:    params.sizeBytes   ?? null,
      content_hash:  params.contentHash ?? null,
    })

  if (error) throw new InternalError(`createExportArtifact failed: ${error.message}`)
}

/**
 * Returns all S3 keys for export artifacts owned by a recipient.
 * Used by Slice 8 (account deletion) to delete S3 objects BEFORE the
 * Postgres cascade removes this table's rows — see migration comment.
 * DDC-003: scoped to a single recipientId.
 */
export async function fetchExportArtifactsByRecipient(
  supabase: SupabaseClient,
  recipientId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('export_artifacts')
    .select('s3_key')
    .eq('recipient_id', recipientId)

  if (error) throw new InternalError(`fetchExportArtifactsByRecipient failed: ${error.message}`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((row: any) => row.s3_key as string)
}

// ── Delete job repository ─────────────────────────────────────────────────────

/** Postgres row shape for a delete_jobs record. */
export interface DeleteJob {
  id:            string
  recipientId:   string
  status:        DeleteStatus
  correlationId: string
  failureReason: string | null
  createdAt:     Date
  updatedAt:     Date
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDeleteJob(row: Record<string, any>): DeleteJob {
  return {
    id:            row.id             as string,
    recipientId:   row.recipient_id   as string,
    status:        row.status         as DeleteStatus,
    correlationId: row.correlation_id as string,
    failureReason: row.failure_reason as string | null,
    createdAt:     new Date(row.created_at as string),
    updatedAt:     new Date(row.updated_at as string),
  }
}

/**
 * Returns the most recent delete job for a recipient (any status), or null.
 * Used by the saga to detect an in-flight or previously failed job.
 * DDC-003: scoped to a single recipientId.
 */
export async function findDeleteJob(
  supabase: SupabaseClient,
  recipientId: string,
): Promise<DeleteJob | null> {
  const { data, error } = await supabase
    .from('delete_jobs')
    .select('*')
    .eq('recipient_id', recipientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new InternalError(`findDeleteJob failed: ${error.message}`)
  return data ? toDeleteJob(data) : null
}

/**
 * Inserts a new delete job row with status 'pending' and returns the created record.
 * DDC-003: scoped to a single recipientId.
 */
export async function createDeleteJob(
  supabase: SupabaseClient,
  params: {
    recipientId:   string
    correlationId: string
  },
): Promise<DeleteJob> {
  const { data, error } = await supabase
    .from('delete_jobs')
    .insert({
      recipient_id:   params.recipientId,
      correlation_id: params.correlationId,
      status:         'pending',
    })
    .select('*')
    .single()

  if (error) throw new InternalError(`createDeleteJob failed: ${error.message}`)
  if (!data)  throw new InternalError('createDeleteJob returned no row')

  return toDeleteJob(data)
}

/**
 * Advances the delete job status from `from` to `to` after asserting the
 * transition is legal. Optionally stamps failureReason.
 * DDC-001: this is the sole write path for delete job status.
 */
export async function updateDeleteJobStatus(
  supabase: SupabaseClient,
  jobId: string,
  from: DeleteStatus,
  to: DeleteStatus,
  extras?: { failureReason?: string },
): Promise<void> {
  // Domain guard — throws on illegal transition before touching the DB.
  assertDeleteTransition(from, to)

  const patch: Record<string, unknown> = {
    status:     to,
    updated_at: new Date().toISOString(),
  }
  if (extras?.failureReason) patch.failure_reason = extras.failureReason

  const { error } = await supabase
    .from('delete_jobs')
    .update(patch)
    .eq('id', jobId)

  if (error) throw new InternalError(`updateDeleteJobStatus failed: ${error.message}`)
}

/**
 * Deletes the recipient row. Cascades all dependent tables:
 * messages, nlu_outcomes, outbound_send_intents, goals, schedules,
 * missed_windows, proactive_policy_state, otp_sessions, rights_sessions,
 * export_jobs, export_artifacts, delete_jobs.
 *
 * MUST be called AFTER S3 objects are deleted — the cascade on export_artifacts
 * removes S3 keys from Postgres, making them unrecoverable if S3 deletion
 * is attempted afterwards (see migration 20260403000001 comment).
 *
 * DDC-001: sole write path for recipient deletion.
 * DDC-003: scoped to a single recipientId.
 */
export async function deleteRecipientById(
  supabase: SupabaseClient,
  recipientId: string,
): Promise<void> {
  const { error } = await supabase
    .from('recipients')
    .delete()
    .eq('id', recipientId)

  if (error) throw new InternalError(`deleteRecipientById failed: ${error.message}`)
}

// ── Bundle data fetcher ───────────────────────────────────────────────────────

/** Raw data collected for the export bundle — generatedAt is set by the application. */
export interface ExportBundleData {
  messages: ExportMessage[]
  goal:     ExportGoal | null
  schedule: ExportSchedule | null
}

/**
 * Fetches all data needed to build the export bundle for a recipient (Q6.R2):
 *   - Message history (text + timestamps, ordered chronologically)
 *   - Active goal config (text + created date)
 *   - Schedule fields (check-in time, timezone, cadence, quiet hours)
 *
 * Columns selected are scoped exactly to Q6.R2. No NLU outcomes, accountability
 * state, internal ids, or derived internals are included.
 *
 * DDC-003: all three queries are scoped to a single recipientId.
 *
 * NOTE: the messages query returns all rows for the recipient with no pagination.
 * This is acceptable at MVP scale (~300 contacts/day per §13 planning band).
 * TODO: add cursor-based pagination for large message histories post-MVP.
 */
export async function fetchExportBundleData(
  supabase: SupabaseClient,
  recipientId: string,
): Promise<ExportBundleData> {
  const [messagesResult, goalResult, scheduleResult] = await Promise.all([
    supabase
      .from('messages')
      .select('direction, body, created_at')
      .eq('recipient_id', recipientId)
      .order('created_at', { ascending: true }),

    supabase
      .from('goals')
      .select('text, created_at')
      .eq('recipient_id', recipientId)
      .eq('active', true)
      .limit(1)
      .maybeSingle(),

    supabase
      .from('schedules')
      .select('check_in_time, timezone, cadence, quiet_hours_start, quiet_hours_end')
      .eq('recipient_id', recipientId)
      .maybeSingle(),
  ])

  if (messagesResult.error) {
    throw new InternalError(`fetchExportBundleData (messages) failed: ${messagesResult.error.message}`)
  }
  if (goalResult.error) {
    throw new InternalError(`fetchExportBundleData (goal) failed: ${goalResult.error.message}`)
  }
  if (scheduleResult.error) {
    throw new InternalError(`fetchExportBundleData (schedule) failed: ${scheduleResult.error.message}`)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: ExportMessage[] = (messagesResult.data ?? []).map((row: any) => ({
    direction: row.direction as 'inbound' | 'outbound',
    body:      row.body      as string,
    sentAt:    row.created_at as string,
  }))

  const goalRow = goalResult.data
  const goal: ExportGoal | null = goalRow
    ? { text: goalRow.text as string, createdAt: goalRow.created_at as string }
    : null

  const schedRow = scheduleResult.data
  const schedule: ExportSchedule | null = schedRow
    ? {
        checkInTime:     schedRow.check_in_time     as string,
        timezone:        schedRow.timezone           as string,
        cadence:         schedRow.cadence            as string,
        quietHoursStart: schedRow.quiet_hours_start  as number,
        quietHoursEnd:   schedRow.quiet_hours_end    as number,
      }
    : null

  return { messages, goal, schedule }
}
