import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ValidationError } from '../../src/shared/errors/index.js'
import { EXPORT_STATUS } from '../../src/modules/user-rights-ops/domain/index.js'
import type { ExportJob } from '../../src/modules/user-rights-ops/data-access/index.js'

// ── Mocks (hoisted before module graph loads) ─────────────────────────────────

vi.mock('../../src/platform/config/index.js', () => ({
  config: {
    NODE_ENV:              'test',
    S3_PREFIX_EXPORTS:     'exports/',
    S3_BUCKET:             'test-bucket',
    S3_PRESIGN_TTL_SECONDS: 86400,
    LOOPMESSAGE_API_KEY:   'test-key',
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
  createS3Client:          vi.fn(),
  checkStorage:            vi.fn(),
}))

vi.mock('../../src/platform/loopmessage-adapter/index.js', () => ({
  sendMessage:             vi.fn(),
  verifyWebhookSignature:  vi.fn(),
}))

vi.mock('../../src/platform/queue-bullmq/queues.js', () => ({
  getQueue:    vi.fn(),
  QUEUE_NAMES: { EXPORT_FULFILLMENT: 'export-fulfillment', DELETE_FULFILLMENT: 'delete-fulfillment' },
}))

vi.mock('../../src/modules/otp-verification/index.js', () => ({
  verifyRightsToken: vi.fn(),
  revokeSession:     vi.fn(),
}))

vi.mock('../../src/modules/identity-recipient/index.js', () => ({
  findRecipientById: vi.fn(),
}))

vi.mock('../../src/modules/user-rights-ops/data-access/index.js', () => ({
  findActiveExportJob:            vi.fn(),
  createExportJob:                vi.fn(),
  updateExportJobStatus:          vi.fn(),
  createExportArtifact:           vi.fn(),
  fetchExportBundleData:          vi.fn(),
  fetchExportArtifactsByRecipient: vi.fn(),
}))

// ── Dynamic imports (after mocks are wired) ───────────────────────────────────

const { fulfillExport } = await import('../../src/modules/user-rights-ops/application/index.js')

const { uploadObject, generatePresignedGetUrl } =
  await import('../../src/platform/storage-s3/index.js')

const { sendMessage } =
  await import('../../src/platform/loopmessage-adapter/index.js')

const {
  findActiveExportJob,
  createExportJob,
  updateExportJobStatus,
  createExportArtifact,
  fetchExportBundleData,
} = await import('../../src/modules/user-rights-ops/data-access/index.js')

const { findRecipientById } =
  await import('../../src/modules/identity-recipient/index.js')

// ── Test fixtures ─────────────────────────────────────────────────────────────

const RECIPIENT_ID     = '00000000-0000-0000-0000-000000000001'
const EXPORT_JOB_ID    = '00000000-0000-0000-0000-000000000002'
const RECIPIENT_HANDLE = '+15551234567'

const VALID_PAYLOAD = {
  recipientId:   RECIPIENT_ID,
  correlationId: 'test-correlation-id',
  requestedAt:   '2026-04-07T12:00:00.000Z',  // Monday, so SLA = Wednesday EOD ET
}

/** Minimal ExportJob fixture — status is overridden per test. */
function makeExportJob(status: string): ExportJob {
  return {
    id:            EXPORT_JOB_ID,
    recipientId:   RECIPIENT_ID,
    status:        status as ExportJob['status'],
    correlationId: 'test-correlation-id',
    slaDeadlineAt: new Date('2026-04-09T23:59:59Z'),
    createdAt:     new Date('2026-04-07T12:00:00Z'),
    updatedAt:     new Date('2026-04-07T12:00:00Z'),
    deliveredAt:   null,
    failedAt:      null,
    failureReason: null,
  }
}

/** Minimal BullMQ Job stub — only id and data are used by fulfillExport. */
function makeJob(data: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { id: `export:${RECIPIENT_ID}`, data } as any
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('fulfillExport — export fulfillment saga (JOB-EXPORT-001)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  // ── Test 1: Happy path ────────────────────────────────────────────────────
  //
  // A new export job arrives (no prior Postgres row). All platform calls
  // succeed. Assert that the full saga completes: S3 upload, iMessage send,
  // and job status stamped as 'delivered'.

  it('happy path — uploads bundle, sends iMessage, marks job delivered', async () => {
    // No existing job → createExportJob is called
    vi.mocked(findActiveExportJob).mockResolvedValue(null)
    vi.mocked(createExportJob).mockResolvedValue(makeExportJob(EXPORT_STATUS.QUEUED))
    vi.mocked(updateExportJobStatus).mockResolvedValue(undefined)
    vi.mocked(fetchExportBundleData).mockResolvedValue({
      messages: [
        { direction: 'inbound',  body: 'Hello!',  sentAt: '2026-04-01T10:00:00.000Z' },
        { direction: 'outbound', body: 'Hi there!', sentAt: '2026-04-01T10:00:05.000Z' },
      ],
      goal:     { text: 'Run a 5k', createdAt: '2026-04-01T09:00:00.000Z' },
      schedule: { checkInTime: '09:00', timezone: 'America/New_York', cadence: 'daily', quietHoursStart: 22, quietHoursEnd: 8 },
    })
    vi.mocked(createExportArtifact).mockResolvedValue(undefined)
    vi.mocked(uploadObject).mockResolvedValue({ sizeBytes: 512 })
    vi.mocked(generatePresignedGetUrl).mockResolvedValue('https://s3.example.com/presigned-url')
    vi.mocked(findRecipientById).mockResolvedValue({
      id:                 RECIPIENT_ID,
      handle:             RECIPIENT_HANDLE,
      firstSeenAt:        new Date('2026-04-01T00:00:00Z'),
      onboardingComplete: true,
      quietHoursTz:       'America/New_York',
      globallyPaused:     false,
      createdAt:          new Date('2026-04-01T00:00:00Z'),
      updatedAt:          new Date('2026-04-01T00:00:00Z'),
    })
    vi.mocked(sendMessage).mockResolvedValue('lm-msg-id')

    await fulfillExport(makeJob(VALID_PAYLOAD))

    // S3 upload happened with the exports/ prefix
    expect(vi.mocked(uploadObject)).toHaveBeenCalledOnce()
    const uploadCall = vi.mocked(uploadObject).mock.calls[0]?.[0]
    expect(uploadCall?.key).toMatch(/^exports\//)
    expect(uploadCall?.contentType).toBe('application/json')

    // Artifact recorded
    expect(vi.mocked(createExportArtifact)).toHaveBeenCalledOnce()

    // iMessage sent to the recipient's handle, not their internal UUID
    expect(vi.mocked(sendMessage)).toHaveBeenCalledOnce()
    expect(vi.mocked(sendMessage).mock.calls[0]?.[0]).toBe(RECIPIENT_HANDLE)

    // Final status stamped as delivered
    const statusCalls = vi.mocked(updateExportJobStatus).mock.calls
    const deliveredCall = statusCalls.find((c) => c[3] === EXPORT_STATUS.DELIVERED)
    expect(deliveredCall).toBeDefined()
  })

  // ── Test 2: Already delivered (idempotency guard) ─────────────────────────
  //
  // The worker receives the job again (BullMQ replay or retry after a delayed
  // failure). The Postgres row already has status 'delivered'. The function
  // must return early without re-uploading or re-sending.

  it('idempotency — returns early without upload or send when already delivered', async () => {
    vi.mocked(findActiveExportJob).mockResolvedValue(makeExportJob(EXPORT_STATUS.DELIVERED))

    await fulfillExport(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(uploadObject)).not.toHaveBeenCalled()
    expect(vi.mocked(sendMessage)).not.toHaveBeenCalled()
    expect(vi.mocked(createExportJob)).not.toHaveBeenCalled()
    expect(vi.mocked(updateExportJobStatus)).not.toHaveBeenCalled()
  })

  // ── Test 3: Invalid payload → ValidationError (DLQ path) ─────────────────
  //
  // The job data is malformed (recipientId is not a UUID). parseOrThrow must
  // throw a ValidationError immediately. BullMQ treats this as a non-retriable
  // failure and moves the job to the failed queue without burning retry attempts.

  it('invalid payload — throws ValidationError without touching the database', async () => {
    const badJob = makeJob({ recipientId: 'not-a-uuid', correlationId: 'x', requestedAt: 'bad-date' })

    await expect(fulfillExport(badJob)).rejects.toBeInstanceOf(ValidationError)

    // Nothing downstream should have been called
    expect(vi.mocked(findActiveExportJob)).not.toHaveBeenCalled()
    expect(vi.mocked(uploadObject)).not.toHaveBeenCalled()
    expect(vi.mocked(sendMessage)).not.toHaveBeenCalled()
  })
})
