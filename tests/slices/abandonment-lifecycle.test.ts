import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/platform/observability/index.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

vi.mock('../../src/platform/db-supabase/index.js', () => ({
  getSupabaseClient: vi.fn(() => ({})),
}))

const mockPauseRecipient = vi.fn()
vi.mock('../../src/modules/identity-recipient/index.js', () => ({
  pauseRecipient: mockPauseRecipient,
}))

const mockFindRecipientsForOutboundStop = vi.fn()
const mockFindRecipientsForPurge        = vi.fn()
vi.mock('../../src/modules/abandonment-lifecycle/data-access/index.js', () => ({
  findRecipientsForOutboundStop: mockFindRecipientsForOutboundStop,
  findRecipientsForPurge:        mockFindRecipientsForPurge,
}))

const mockQueueAdd = vi.fn()
vi.mock('../../src/platform/queue-bullmq/queues.js', () => ({
  getQueue:    vi.fn(() => ({ add: mockQueueAdd })),
  QUEUE_NAMES: { DELETE_FULFILLMENT: 'delete-fulfillment' },
}))

// ── Dynamic imports (after mocks) ─────────────────────────────────────────────

const { enforceOutboundStop, enqueuePreGoalPurges } =
  await import('../../src/modules/abandonment-lifecycle/application/index.js')

// ── Fixtures ──────────────────────────────────────────────────────────────────

const R1 = { id: '00000000-0000-0000-0000-000000000001', firstSeenAt: new Date('2026-01-01') }
const R2 = { id: '00000000-0000-0000-0000-000000000002', firstSeenAt: new Date('2026-01-01') }

// ── enforceOutboundStop ───────────────────────────────────────────────────────

describe('enforceOutboundStop (Q3.R3 — 7-day outbound stop)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockQueueAdd.mockResolvedValue(undefined)
  })

  it('does nothing when no eligible recipients are found', async () => {
    mockFindRecipientsForOutboundStop.mockResolvedValue([])

    await enforceOutboundStop()

    expect(mockPauseRecipient).not.toHaveBeenCalled()
  })

  it('calls pauseRecipient once per eligible recipient', async () => {
    mockFindRecipientsForOutboundStop.mockResolvedValue([R1, R2])
    mockPauseRecipient.mockResolvedValue(undefined)

    await enforceOutboundStop()

    expect(mockPauseRecipient).toHaveBeenCalledTimes(2)
    expect(mockPauseRecipient).toHaveBeenCalledWith(R1.id)
    expect(mockPauseRecipient).toHaveBeenCalledWith(R2.id)
  })

  it('continues the batch when one pauseRecipient call throws (per-item resilience)', async () => {
    mockFindRecipientsForOutboundStop.mockResolvedValue([R1, R2])
    mockPauseRecipient
      .mockRejectedValueOnce(new Error('db timeout'))
      .mockResolvedValueOnce(undefined)

    // Must not throw
    await expect(enforceOutboundStop()).resolves.toBeUndefined()

    // Both recipients were attempted despite the first failure
    expect(mockPauseRecipient).toHaveBeenCalledTimes(2)
  })

  it('does not call pauseRecipient again for a recipient that is already paused (filtered by data-access)', async () => {
    // The data-access layer already excludes globally_paused=true rows.
    // This test verifies the application layer doesn't add extra guard calls.
    mockFindRecipientsForOutboundStop.mockResolvedValue([R1])
    mockPauseRecipient.mockResolvedValue(undefined)

    await enforceOutboundStop()

    expect(mockPauseRecipient).toHaveBeenCalledTimes(1)
  })
})

// ── enqueuePreGoalPurges ──────────────────────────────────────────────────────

describe('enqueuePreGoalPurges (Q3.R3 — 90-day pre-goal purge)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockQueueAdd.mockResolvedValue(undefined)
  })

  it('does nothing when no eligible recipients are found', async () => {
    mockFindRecipientsForPurge.mockResolvedValue([])

    await enqueuePreGoalPurges()

    expect(mockQueueAdd).not.toHaveBeenCalled()
  })

  it('enqueues a delete job for each eligible recipient', async () => {
    mockFindRecipientsForPurge.mockResolvedValue([R1, R2])

    await enqueuePreGoalPurges()

    expect(mockQueueAdd).toHaveBeenCalledTimes(2)
  })

  it('uses deterministic jobId = delete:{recipientId} for BullMQ deduplication (AIC-003)', async () => {
    mockFindRecipientsForPurge.mockResolvedValue([R1])

    await enqueuePreGoalPurges()

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'delete-fulfillment',
      expect.objectContaining({ recipientId: R1.id }),
      expect.objectContaining({ jobId: `delete:${R1.id}` }),
    )
  })

  it('sets attempts:5 and exponential backoff on each enqueued job', async () => {
    mockFindRecipientsForPurge.mockResolvedValue([R1])

    await enqueuePreGoalPurges()

    expect(mockQueueAdd).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
      }),
    )
  })

  it('continues the batch when one enqueue call throws (per-item resilience)', async () => {
    mockFindRecipientsForPurge.mockResolvedValue([R1, R2])
    mockQueueAdd
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValueOnce(undefined)

    await expect(enqueuePreGoalPurges()).resolves.toBeUndefined()

    expect(mockQueueAdd).toHaveBeenCalledTimes(2)
  })

  it('sets correlationId = purge:{recipientId} in the job payload', async () => {
    mockFindRecipientsForPurge.mockResolvedValue([R1])

    await enqueuePreGoalPurges()

    expect(mockQueueAdd).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ correlationId: `purge:${R1.id}` }),
      expect.any(Object),
    )
  })
})
