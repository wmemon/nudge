import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ValidationError } from '../../src/shared/errors/index.js'
import { DELETE_STATUS } from '../../src/modules/user-rights-ops/domain/index.js'
import type { DeleteJob } from '../../src/modules/user-rights-ops/data-access/index.js'

// ── Mocks (hoisted before module graph loads) ─────────────────────────────────

vi.mock('../../src/platform/config/index.js', () => ({
  config: {
    NODE_ENV:                   'test',
    S3_PREFIX_EXPORTS:          'exports/',
    S3_BUCKET:                  'test-bucket',
    LOOPMESSAGE_API_KEY:        'test-key',
    ENFORCE_OUTBOUND_ALLOWLIST: 'true',
  },
}))

vi.mock('../../src/platform/observability/index.js', () => ({
  createLogger: () => ({
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../../src/platform/db-supabase/index.js', () => ({
  getSupabaseClient: vi.fn(() => ({})),
}))

vi.mock('../../src/platform/storage-s3/index.js', () => ({
  uploadObject:            vi.fn(),
  generatePresignedGetUrl: vi.fn(),
  deleteObjects:           vi.fn(),
  createS3Client:          vi.fn(),
  checkStorage:            vi.fn(),
}))

vi.mock('../../src/platform/loopmessage-adapter/index.js', () => ({
  sendMessage:            vi.fn(),
  verifyWebhookSignature: vi.fn(),
}))

// getQueue returns a shared mock object with a remove() method for all queues.
const mockQueueRemove = vi.fn().mockResolvedValue(1)
vi.mock('../../src/platform/queue-bullmq/queues.js', () => ({
  getQueue: vi.fn(() => ({ remove: mockQueueRemove })),
  QUEUE_NAMES: {
    EXPORT_FULFILLMENT: 'export-fulfillment',
    SCHEDULED_CHECKIN:  'scheduled-checkin',
    DELETE_FULFILLMENT: 'delete-fulfillment',
  },
}))

vi.mock('../../src/modules/otp-verification/index.js', () => ({
  verifyRightsToken: vi.fn(),
  revokeSession:     vi.fn(),
}))

vi.mock('../../src/modules/identity-recipient/index.js', () => ({
  findRecipientById: vi.fn(),
}))

vi.mock('../../src/modules/goal-scheduling/index.js', () => ({
  getScheduleForRecipient: vi.fn(),
}))

vi.mock('../../src/modules/user-rights-ops/data-access/index.js', () => ({
  // export job functions (needed because the same module also exports these)
  findActiveExportJob:             vi.fn(),
  createExportJob:                 vi.fn(),
  updateExportJobStatus:           vi.fn(),
  createExportArtifact:            vi.fn(),
  fetchExportBundleData:           vi.fn(),
  // delete job functions
  fetchExportArtifactsByRecipient: vi.fn(),
  findDeleteJob:                   vi.fn(),
  createDeleteJob:                 vi.fn(),
  updateDeleteJobStatus:           vi.fn(),
  deleteRecipientById:             vi.fn(),
}))

// ── Dynamic imports (after mocks are wired) ───────────────────────────────────

const { fulfillDelete } =
  await import('../../src/modules/user-rights-ops/application/index.js')

const { deleteObjects } =
  await import('../../src/platform/storage-s3/index.js')

const { findRecipientById } =
  await import('../../src/modules/identity-recipient/index.js')

const { getScheduleForRecipient } =
  await import('../../src/modules/goal-scheduling/index.js')

const {
  fetchExportArtifactsByRecipient,
  findDeleteJob,
  createDeleteJob,
  updateDeleteJobStatus,
  deleteRecipientById,
} = await import('../../src/modules/user-rights-ops/data-access/index.js')

// ── Test fixtures ─────────────────────────────────────────────────────────────

const RECIPIENT_ID     = '00000000-0000-0000-0000-000000000001'
const DELETE_JOB_ID    = '00000000-0000-0000-0000-000000000002'
const RECIPIENT_HANDLE = '+15551234567'
const NEXT_RUN_AT      = new Date('2026-04-10T14:00:00.000Z')

const VALID_PAYLOAD = {
  recipientId:   RECIPIENT_ID,
  correlationId: 'test-correlation-id',
  requestedAt:   '2026-04-05T10:00:00.000Z',
}

const MOCK_RECIPIENT = {
  id:                 RECIPIENT_ID,
  handle:             RECIPIENT_HANDLE,
  firstSeenAt:        new Date('2026-04-01T00:00:00Z'),
  onboardingComplete: true,
  quietHoursTz:       'America/New_York',
  globallyPaused:     false,
  createdAt:          new Date('2026-04-01T00:00:00Z'),
  updatedAt:          new Date('2026-04-01T00:00:00Z'),
}

function makeDeleteJob(status: string): DeleteJob {
  return {
    id:            DELETE_JOB_ID,
    recipientId:   RECIPIENT_ID,
    status:        status as DeleteJob['status'],
    correlationId: 'test-correlation-id',
    failureReason: null,
    createdAt:     new Date('2026-04-05T10:00:00Z'),
    updatedAt:     new Date('2026-04-05T10:00:00Z'),
  }
}

/** Minimal BullMQ Job stub. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeJob(data: unknown) { return { id: `delete:${RECIPIENT_ID}`, data } as any }

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('fulfillDelete — account deletion saga (JOB-DELETE-001)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockQueueRemove.mockResolvedValue(1)
  })

  // ── Test 1: Happy path ────────────────────────────────────────────────────
  //
  // New deletion request. Recipient exists, two S3 keys on file, schedule has
  // a nextRunAt. Assert the full saga: S3 keys collected first, BullMQ jobs
  // cancelled, S3 objects deleted, recipient deleted.

  it('happy path — collects S3 keys, cancels jobs, deletes S3 objects, deletes recipient', async () => {
    vi.mocked(findRecipientById).mockResolvedValue(MOCK_RECIPIENT)
    vi.mocked(findDeleteJob).mockResolvedValue(null)
    vi.mocked(createDeleteJob).mockResolvedValue(makeDeleteJob(DELETE_STATUS.PENDING))
    vi.mocked(updateDeleteJobStatus).mockResolvedValue(undefined)
    vi.mocked(fetchExportArtifactsByRecipient).mockResolvedValue([
      'exports/recipient-1/job-1/export.json',
      'exports/recipient-1/job-2/export.json',
    ])
    vi.mocked(getScheduleForRecipient).mockResolvedValue({
      id: 'sched-1', recipientId: RECIPIENT_ID, goalId: 'goal-1',
      checkInTime: '09:00', timezone: 'America/New_York', cadence: 'daily',
      quietHoursStart: 22, quietHoursEnd: 8, paused: false, snoozeUntil: null,
      nextRunAt: NEXT_RUN_AT, createdAt: new Date(), updatedAt: new Date(),
    })
    vi.mocked(deleteRecipientById).mockResolvedValue(undefined)

    await fulfillDelete(makeJob(VALID_PAYLOAD))

    // S3 key collection happened before recipient deletion
    expect(vi.mocked(fetchExportArtifactsByRecipient)).toHaveBeenCalledWith(
      expect.anything(),
      RECIPIENT_ID,
    )

    // S3 objects deleted with the collected keys
    expect(vi.mocked(deleteObjects)).toHaveBeenCalledWith([
      'exports/recipient-1/job-1/export.json',
      'exports/recipient-1/job-2/export.json',
    ])

    // BullMQ export job cancelled
    expect(mockQueueRemove).toHaveBeenCalledWith(`export:${RECIPIENT_ID}`)

    // BullMQ check-in job cancelled using deterministic job id
    expect(mockQueueRemove).toHaveBeenCalledWith(
      `checkin:${RECIPIENT_ID}:${NEXT_RUN_AT.toISOString()}`,
    )

    // Recipient deleted (triggers Postgres cascade)
    expect(vi.mocked(deleteRecipientById)).toHaveBeenCalledWith(
      expect.anything(),
      RECIPIENT_ID,
    )
  })

  // ── Test 2: Idempotency — recipient already deleted ───────────────────────
  //
  // BullMQ replays the job after a successful prior run. The recipient row
  // is already gone. The function must return early without touching S3 or
  // Postgres again.

  it('idempotency — returns early when recipient is already gone', async () => {
    vi.mocked(findRecipientById).mockResolvedValue(null)

    await fulfillDelete(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(fetchExportArtifactsByRecipient)).not.toHaveBeenCalled()
    expect(vi.mocked(deleteObjects)).not.toHaveBeenCalled()
    expect(vi.mocked(deleteRecipientById)).not.toHaveBeenCalled()
    expect(vi.mocked(findDeleteJob)).not.toHaveBeenCalled()
  })

  // ── Test 3: Retry — delete_jobs already executing ─────────────────────────
  //
  // The worker crashed mid-saga on a prior attempt and left the delete_jobs
  // row in 'executing' state. The retry must skip the pending→executing
  // transition (which would be an illegal state machine move) but still
  // complete the saga and delete the recipient.

  it('retry path — skips status transition when already executing, completes saga', async () => {
    vi.mocked(findRecipientById).mockResolvedValue(MOCK_RECIPIENT)
    vi.mocked(findDeleteJob).mockResolvedValue(makeDeleteJob(DELETE_STATUS.EXECUTING))
    vi.mocked(updateDeleteJobStatus).mockResolvedValue(undefined)
    vi.mocked(fetchExportArtifactsByRecipient).mockResolvedValue([])
    vi.mocked(getScheduleForRecipient).mockResolvedValue(null)
    vi.mocked(deleteRecipientById).mockResolvedValue(undefined)

    await fulfillDelete(makeJob(VALID_PAYLOAD))

    // No status transition attempted — row was already executing
    expect(vi.mocked(updateDeleteJobStatus)).not.toHaveBeenCalled()

    // Saga still ran to completion
    expect(vi.mocked(deleteRecipientById)).toHaveBeenCalledOnce()
  })

  // ── Test 4: Invalid payload → ValidationError (DLQ path) ─────────────────
  //
  // The job data is malformed (recipientId is not a UUID). parseOrThrow must
  // throw ValidationError immediately. BullMQ treats this as non-retriable
  // and moves the job to the failed queue without burning retry attempts.

  it('invalid payload — throws ValidationError without touching the database', async () => {
    const badJob = makeJob({ recipientId: 'not-a-uuid', correlationId: 'x', requestedAt: 'bad' })

    await expect(fulfillDelete(badJob)).rejects.toBeInstanceOf(ValidationError)

    expect(vi.mocked(findRecipientById)).not.toHaveBeenCalled()
    expect(vi.mocked(deleteRecipientById)).not.toHaveBeenCalled()
    expect(vi.mocked(deleteObjects)).not.toHaveBeenCalled()
  })
})
