import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Config mock ───────────────────────────────────────────────────────────────

const mockConfig = {
  USAGE_GOAL_WARN_THRESHOLD:    9999,
  USAGE_CHECKIN_WARN_THRESHOLD: 9999,
}

vi.mock('../../src/platform/config/index.js', () => ({ config: mockConfig }))

// ── Other mocks ───────────────────────────────────────────────────────────────

vi.mock('../../src/platform/observability/index.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

vi.mock('../../src/platform/db-supabase/index.js', () => ({
  getSupabaseClient: vi.fn(() => ({})),
}))

const mockIncrementCounter = vi.fn()
vi.mock('../../src/modules/usage-metering/data-access/index.js', () => ({
  incrementCounter: mockIncrementCounter,
}))

// ── Dynamic imports (after mocks) ─────────────────────────────────────────────

const { incrementGoalCount, incrementCheckinCount } =
  await import('../../src/modules/usage-metering/application/index.js')

// ── Fixtures ──────────────────────────────────────────────────────────────────

const RECIPIENT_ID = '00000000-0000-0000-0000-000000000001'

function makeCounter(count: number, metricType: 'goals_set' | 'checkins_completed') {
  return {
    id:          '00000000-0000-0000-0000-000000000099',
    recipientId: RECIPIENT_ID,
    metricType,
    count,
    updatedAt:   new Date(),
  }
}

// ── incrementGoalCount ────────────────────────────────────────────────────────

describe('incrementGoalCount (Q1.R1 — soft usage metering)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockConfig.USAGE_GOAL_WARN_THRESHOLD    = 9999
    mockConfig.USAGE_CHECKIN_WARN_THRESHOLD = 9999
  })

  it('returns count=1 and shouldWarn=false on first increment', async () => {
    mockIncrementCounter.mockResolvedValue(makeCounter(1, 'goals_set'))

    const result = await incrementGoalCount(RECIPIENT_ID)

    expect(result).toEqual({ count: 1, shouldWarn: false })
  })

  it('calls incrementCounter with metric_type goals_set', async () => {
    mockIncrementCounter.mockResolvedValue(makeCounter(1, 'goals_set'))

    await incrementGoalCount(RECIPIENT_ID)

    expect(mockIncrementCounter).toHaveBeenCalledWith(
      expect.anything(),
      RECIPIENT_ID,
      'goals_set',
    )
  })

  it('returns shouldWarn=true when count reaches USAGE_GOAL_WARN_THRESHOLD', async () => {
    mockConfig.USAGE_GOAL_WARN_THRESHOLD = 3
    mockIncrementCounter.mockResolvedValue(makeCounter(3, 'goals_set'))

    const result = await incrementGoalCount(RECIPIENT_ID)

    expect(result.shouldWarn).toBe(true)
    expect(result.count).toBe(3)
  })

  it('returns shouldWarn=false when count is below threshold', async () => {
    mockConfig.USAGE_GOAL_WARN_THRESHOLD = 5
    mockIncrementCounter.mockResolvedValue(makeCounter(4, 'goals_set'))

    const result = await incrementGoalCount(RECIPIENT_ID)

    expect(result.shouldWarn).toBe(false)
  })

  it('propagates errors from incrementCounter (caller is responsible for .catch)', async () => {
    mockIncrementCounter.mockRejectedValue(new Error('db error'))

    await expect(incrementGoalCount(RECIPIENT_ID)).rejects.toThrow('db error')
  })
})

// ── incrementCheckinCount ─────────────────────────────────────────────────────

describe('incrementCheckinCount (Q1.R1 — soft usage metering)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockConfig.USAGE_GOAL_WARN_THRESHOLD    = 9999
    mockConfig.USAGE_CHECKIN_WARN_THRESHOLD = 9999
  })

  it('returns count=1 and shouldWarn=false on first increment', async () => {
    mockIncrementCounter.mockResolvedValue(makeCounter(1, 'checkins_completed'))

    const result = await incrementCheckinCount(RECIPIENT_ID)

    expect(result).toEqual({ count: 1, shouldWarn: false })
  })

  it('calls incrementCounter with metric_type checkins_completed', async () => {
    mockIncrementCounter.mockResolvedValue(makeCounter(1, 'checkins_completed'))

    await incrementCheckinCount(RECIPIENT_ID)

    expect(mockIncrementCounter).toHaveBeenCalledWith(
      expect.anything(),
      RECIPIENT_ID,
      'checkins_completed',
    )
  })

  it('returns shouldWarn=true when count reaches USAGE_CHECKIN_WARN_THRESHOLD', async () => {
    mockConfig.USAGE_CHECKIN_WARN_THRESHOLD = 10
    mockIncrementCounter.mockResolvedValue(makeCounter(10, 'checkins_completed'))

    const result = await incrementCheckinCount(RECIPIENT_ID)

    expect(result.shouldWarn).toBe(true)
    expect(result.count).toBe(10)
  })

  it('returns shouldWarn=false when count is below threshold', async () => {
    mockConfig.USAGE_CHECKIN_WARN_THRESHOLD = 10
    mockIncrementCounter.mockResolvedValue(makeCounter(9, 'checkins_completed'))

    const result = await incrementCheckinCount(RECIPIENT_ID)

    expect(result.shouldWarn).toBe(false)
  })

  it('propagates errors from incrementCounter (caller is responsible for .catch)', async () => {
    mockIncrementCounter.mockRejectedValue(new Error('redis blip'))

    await expect(incrementCheckinCount(RECIPIENT_ID)).rejects.toThrow('redis blip')
  })

  it('does not use goals_set threshold for checkin metric', async () => {
    // Separate thresholds — goal threshold firing must not affect checkin result
    mockConfig.USAGE_GOAL_WARN_THRESHOLD    = 1  // would trigger if wrong metric used
    mockConfig.USAGE_CHECKIN_WARN_THRESHOLD = 9999
    mockIncrementCounter.mockResolvedValue(makeCounter(5, 'checkins_completed'))

    const result = await incrementCheckinCount(RECIPIENT_ID)

    expect(result.shouldWarn).toBe(false)
  })
})
