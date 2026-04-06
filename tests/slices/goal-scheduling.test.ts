import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Job } from 'bullmq'

// ── Config mock ───────────────────────────────────────────────────────────────

const mockConfig = {
  NODE_ENV:                'test' as string,
  PROACTIVE_SENDS_ENABLED: true,
}

vi.mock('../../src/platform/config/index.js', () => ({ config: mockConfig }))

// ── Application-layer mocks (avoid real DB / Redis calls) ─────────────────────

const mockScheduleNextCheckin     = vi.fn()
const mockRecordMissedWindow      = vi.fn()
const mockGetScheduleForRecipient = vi.fn()

vi.mock('../../src/modules/goal-scheduling/application/index.js', () => ({
  MISSED_WINDOW_THRESHOLD_MINUTES: 60,
  scheduleNextCheckin:             mockScheduleNextCheckin,
  recordMissedWindow:              mockRecordMissedWindow,
  getScheduleForRecipient:         mockGetScheduleForRecipient,
  // Unused by the handler but present in the module export surface
  captureGoal:  vi.fn(),
  getActiveGoal: vi.fn(),
}))

// ── External boundary mocks ───────────────────────────────────────────────────

vi.mock('../../src/modules/identity-recipient/index.js', () => ({
  findRecipientById: vi.fn(),
}))

vi.mock('../../src/modules/outbound-messaging/index.js', () => ({
  sendOutboundMessage: vi.fn(),
}))

const mockCheckCanSendProactive = vi.fn()
const mockRecordProactiveSent   = vi.fn()

vi.mock('../../src/modules/proactive-policy/index.js', () => ({
  checkCanSendProactive: mockCheckCanSendProactive,
  recordProactiveSent:   mockRecordProactiveSent,
}))

// Suppress log noise
vi.mock('../../src/platform/observability/index.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

// ── Imports after mocks ───────────────────────────────────────────────────────

const { handleScheduledCheckinJob } = await import('../../src/modules/goal-scheduling/index.js')
const { findRecipientById }         = await import('../../src/modules/identity-recipient/index.js')
const { sendOutboundMessage }       = await import('../../src/modules/outbound-messaging/index.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJob(data: Record<string, unknown>, id = 'job-sched-001'): Job {
  return { id, data } as unknown as Job
}

const RECIPIENT_ID  = '00000000-0000-0000-0000-000000000001'
const RECENT_SCHED_AT = new Date(Date.now() - 5_000).toISOString()      // 5 s ago — within threshold
const LATE_SCHED_AT   = new Date(Date.now() - 90 * 60_000).toISOString() // 90 min ago — exceeds threshold

const VALID_PAYLOAD = {
  recipientId:   RECIPIENT_ID,
  scheduledAt:   RECENT_SCHED_AT,
  correlationId: 'corr-abc-123',
}

const MOCK_RECIPIENT = {
  id:                 RECIPIENT_ID,
  handle:             '+13231112233',
  firstSeenAt:        new Date(),
  onboardingComplete: true,
  quietHoursTz:       null,
  globallyPaused:     false,
  createdAt:          new Date(),
  updatedAt:          new Date(),
}

const MOCK_SCHEDULE = {
  id:              '00000000-0000-0000-0000-000000000002',
  recipientId:     RECIPIENT_ID,
  goalId:          '00000000-0000-0000-0000-000000000003',
  checkInTime:     '09:00',
  timezone:        'UTC',
  cadence:         'daily' as const,
  quietHoursStart: 22,
  quietHoursEnd:   8,
  paused:          false,
  snoozeUntil:     null,
  nextRunAt:       null,
  createdAt:       new Date(),
  updatedAt:       new Date(),
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleScheduledCheckinJob (JOB-SCHED-001)', () => {
  beforeEach(() => {
    mockConfig.PROACTIVE_SENDS_ENABLED = true

    vi.mocked(findRecipientById).mockResolvedValue(MOCK_RECIPIENT)
    mockGetScheduleForRecipient.mockResolvedValue(MOCK_SCHEDULE)
    mockScheduleNextCheckin.mockResolvedValue(undefined)
    mockRecordMissedWindow.mockResolvedValue(undefined)
    vi.mocked(sendOutboundMessage).mockResolvedValue(undefined)
    mockCheckCanSendProactive.mockResolvedValue({ allowed: true })
    mockRecordProactiveSent.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  // ── Test 1: happy path ─────────────────────────────────────────────────────

  it('sends check-in message, records proactive send, and schedules next when all conditions are met', async () => {
    await handleScheduledCheckinJob(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(sendOutboundMessage)).toHaveBeenCalledOnce()
    expect(vi.mocked(sendOutboundMessage)).toHaveBeenCalledWith(
      MOCK_RECIPIENT.id,
      MOCK_RECIPIENT.handle,
      expect.any(String),
      `checkin:${RECIPIENT_ID}:${RECENT_SCHED_AT}`,
      VALID_PAYLOAD.correlationId,
    )
    expect(mockRecordProactiveSent).toHaveBeenCalledOnce()
    expect(mockRecordProactiveSent).toHaveBeenCalledWith(RECIPIENT_ID)
    expect(mockScheduleNextCheckin).toHaveBeenCalledWith(RECIPIENT_ID)
    expect(mockRecordMissedWindow).not.toHaveBeenCalled()
  })

  // ── Test 2: late job → missed window recorded, no send ────────────────────

  it('records missed window and reschedules without sending when job fires > 60 min late (Q12.3)', async () => {
    const latePayload = { ...VALID_PAYLOAD, scheduledAt: LATE_SCHED_AT }

    await handleScheduledCheckinJob(makeJob(latePayload))

    expect(mockRecordMissedWindow).toHaveBeenCalledOnce()
    expect(mockRecordMissedWindow).toHaveBeenCalledWith(
      RECIPIENT_ID,
      new Date(LATE_SCHED_AT),
      'downtime',
    )
    expect(mockScheduleNextCheckin).toHaveBeenCalledWith(RECIPIENT_ID)
    expect(vi.mocked(sendOutboundMessage)).not.toHaveBeenCalled()
  })

  // ── Test 3: proactive sends disabled → reschedule, no send ────────────────

  it('reschedules without sending when PROACTIVE_SENDS_ENABLED is false (ADR §13)', async () => {
    mockConfig.PROACTIVE_SENDS_ENABLED = false

    await handleScheduledCheckinJob(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(sendOutboundMessage)).not.toHaveBeenCalled()
    expect(mockScheduleNextCheckin).toHaveBeenCalledWith(RECIPIENT_ID)
    expect(mockRecordMissedWindow).not.toHaveBeenCalled()
  })

  // ── Test 4: schedule paused → missed window recorded, no send ─────────────

  it('records missed window and reschedules without sending when schedule is paused (Q3.2)', async () => {
    mockGetScheduleForRecipient.mockResolvedValue({ ...MOCK_SCHEDULE, paused: true })

    await handleScheduledCheckinJob(makeJob(VALID_PAYLOAD))

    expect(mockRecordMissedWindow).toHaveBeenCalledOnce()
    expect(mockRecordMissedWindow).toHaveBeenCalledWith(
      RECIPIENT_ID,
      new Date(RECENT_SCHED_AT),
      'paused',
    )
    expect(mockScheduleNextCheckin).toHaveBeenCalledWith(RECIPIENT_ID)
    expect(vi.mocked(sendOutboundMessage)).not.toHaveBeenCalled()
  })

  // ── Test 5: snooze active → reschedule, no missed window, no send ─────────

  it('reschedules without missed window or send when snooze is still active', async () => {
    const snoozeUntil = new Date(Date.now() + 60 * 60_000) // 1 hour from now
    mockGetScheduleForRecipient.mockResolvedValue({ ...MOCK_SCHEDULE, snoozeUntil })

    await handleScheduledCheckinJob(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(sendOutboundMessage)).not.toHaveBeenCalled()
    expect(mockRecordMissedWindow).not.toHaveBeenCalled()
    expect(mockScheduleNextCheckin).toHaveBeenCalledWith(RECIPIENT_ID)
  })

  // ── Test 6: no schedule found → return early ──────────────────────────────

  it('returns early without send or reschedule when schedule is not found', async () => {
    mockGetScheduleForRecipient.mockResolvedValue(null)

    await handleScheduledCheckinJob(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(sendOutboundMessage)).not.toHaveBeenCalled()
    expect(mockScheduleNextCheckin).not.toHaveBeenCalled()
    expect(mockRecordMissedWindow).not.toHaveBeenCalled()
  })

  // ── Test 7: recipient not found → return early ────────────────────────────

  it('returns early without send when recipient is not found', async () => {
    vi.mocked(findRecipientById).mockResolvedValue(null)

    await handleScheduledCheckinJob(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(sendOutboundMessage)).not.toHaveBeenCalled()
    expect(mockScheduleNextCheckin).not.toHaveBeenCalled()
  })

  // ── Test 8: invalid payload → throws (VID-001) ────────────────────────────

  it('throws on missing required fields so BullMQ marks the job failed (VID-001)', async () => {
    const badPayload = { recipientId: 'not-a-uuid', scheduledAt: 'not-a-date' }

    await expect(handleScheduledCheckinJob(makeJob(badPayload))).rejects.toThrow()

    expect(vi.mocked(sendOutboundMessage)).not.toHaveBeenCalled()
  })

  // ── Test 9: proactive policy gate blocks → reschedule, no send (ADR §13) ──

  it('reschedules without sending when proactive policy gate blocks the send (ADR §13)', async () => {
    mockCheckCanSendProactive.mockResolvedValue({ allowed: false, reason: 'cap_24h' })

    await handleScheduledCheckinJob(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(sendOutboundMessage)).not.toHaveBeenCalled()
    expect(mockRecordProactiveSent).not.toHaveBeenCalled()
    expect(mockScheduleNextCheckin).toHaveBeenCalledWith(RECIPIENT_ID)
  })

  // ── Test 10: proactive policy gate allows → recordProactiveSent called ────

  it('calls recordProactiveSent exactly once after a successful send (ADR §13)', async () => {
    mockCheckCanSendProactive.mockResolvedValue({ allowed: true })

    await handleScheduledCheckinJob(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(sendOutboundMessage)).toHaveBeenCalledOnce()
    expect(mockRecordProactiveSent).toHaveBeenCalledOnce()
    expect(mockRecordProactiveSent).toHaveBeenCalledWith(RECIPIENT_ID)
  })
})
