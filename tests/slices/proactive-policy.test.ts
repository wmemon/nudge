import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Config mock ───────────────────────────────────────────────────────────────

const mockConfig = {
  PROACTIVE_CAP_PER_24H:        8,
  PROACTIVE_MIN_SPACING_MINUTES: 90,
}

vi.mock('../../src/platform/config/index.js', () => ({ config: mockConfig }))

// ── Data-access mock ──────────────────────────────────────────────────────────

const mockFindPolicyState   = vi.fn()
const mockUpsertPolicyState = vi.fn()

vi.mock('../../src/modules/proactive-policy/data-access/index.js', () => ({
  findPolicyState:   mockFindPolicyState,
  upsertPolicyState: mockUpsertPolicyState,
}))

// ── Platform mocks ────────────────────────────────────────────────────────────

vi.mock('../../src/platform/db-supabase/index.js', () => ({
  getSupabaseClient: () => ({}),
}))

vi.mock('../../src/platform/observability/index.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

// ── Imports after mocks ───────────────────────────────────────────────────────

const {
  checkCanSendProactive,
  recordProactiveSent,
  recordInboundReply,
} = await import('../../src/modules/proactive-policy/index.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

const RECIPIENT_ID = '00000000-0000-0000-0000-000000000001'

const WINDOW_24H_MS = 24 * 60 * 60 * 1000
const WINDOW_7D_MS  = 7  * 24 * 60 * 60 * 1000

/** Builds a full ProactivePolicyState fixture with sensible defaults. */
function makeState(overrides: Partial<{
  lastProactiveSentAt:     Date | null
  effectiveSpacingMinutes: number
  rolling24hCount:         number
  rolling24hWindowStart:   Date
  proactiveCount7d:        number
  inboundReplies7d:        number
  window7dStartedAt:       Date
}> = {}) {
  const now = new Date()
  return {
    id:                      '00000000-0000-0000-0000-000000000099',
    recipientId:             RECIPIENT_ID,
    lastProactiveSentAt:     null,
    effectiveSpacingMinutes: 90,
    rolling24hCount:         0,
    rolling24hWindowStart:   now,
    proactiveCount7d:        0,
    inboundReplies7d:        0,
    window7dStartedAt:       now,
    createdAt:               now,
    updatedAt:               now,
    ...overrides,
  }
}

// ── Tests: checkCanSendProactive ──────────────────────────────────────────────

describe('checkCanSendProactive', () => {
  beforeEach(() => {
    mockUpsertPolicyState.mockResolvedValue(makeState())
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('allows send when no state row exists yet (first-time recipient)', async () => {
    mockFindPolicyState.mockResolvedValue(null)

    const result = await checkCanSendProactive(RECIPIENT_ID)

    expect(result.allowed).toBe(true)
  })

  it('allows send when count is below cap and spacing has elapsed', async () => {
    mockFindPolicyState.mockResolvedValue(makeState({
      rolling24hCount:      3,
      lastProactiveSentAt:  new Date(Date.now() - 120 * 60_000), // 120 min ago > 90 min spacing
    }))

    const result = await checkCanSendProactive(RECIPIENT_ID)

    expect(result.allowed).toBe(true)
  })

  it('blocks when rolling 24h count has reached the cap', async () => {
    mockFindPolicyState.mockResolvedValue(makeState({
      rolling24hCount:     8,
      rolling24hWindowStart: new Date(Date.now() - 60 * 60_000), // window still active
    }))

    const result = await checkCanSendProactive(RECIPIENT_ID)

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('cap_24h')
  })

  it('allows send when 24h window has expired even if count was at cap', async () => {
    mockFindPolicyState.mockResolvedValue(makeState({
      rolling24hCount:      8,
      rolling24hWindowStart: new Date(Date.now() - WINDOW_24H_MS - 1000), // window expired
      lastProactiveSentAt:  new Date(Date.now() - 120 * 60_000),          // spacing satisfied
    }))

    const result = await checkCanSendProactive(RECIPIENT_ID)

    expect(result.allowed).toBe(true)
  })

  it('blocks when last send was too recent (spacing not elapsed)', async () => {
    mockFindPolicyState.mockResolvedValue(makeState({
      rolling24hCount:     1,
      lastProactiveSentAt: new Date(Date.now() - 30 * 60_000), // only 30 min ago < 90 min
      effectiveSpacingMinutes: 90,
    }))

    const result = await checkCanSendProactive(RECIPIENT_ID)

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('spacing')
  })

  it('allows send when last send was exactly at the spacing threshold', async () => {
    mockFindPolicyState.mockResolvedValue(makeState({
      rolling24hCount:     1,
      lastProactiveSentAt: new Date(Date.now() - 91 * 60_000), // 91 min ago > 90 min spacing
      effectiveSpacingMinutes: 90,
    }))

    const result = await checkCanSendProactive(RECIPIENT_ID)

    expect(result.allowed).toBe(true)
  })

  it('respects an elevated effective spacing from prior backoff', async () => {
    mockFindPolicyState.mockResolvedValue(makeState({
      rolling24hCount:     1,
      lastProactiveSentAt: new Date(Date.now() - 120 * 60_000), // 120 min ago
      effectiveSpacingMinutes: 135,                              // backed off from 90 → 135
    }))

    const result = await checkCanSendProactive(RECIPIENT_ID)

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('spacing')
  })
})

// ── Tests: recordProactiveSent ────────────────────────────────────────────────

describe('recordProactiveSent', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  it('increments 24h count and stamps lastProactiveSentAt', async () => {
    mockFindPolicyState.mockResolvedValue(makeState({ rolling24hCount: 2 }))
    mockUpsertPolicyState.mockResolvedValue(makeState())

    await recordProactiveSent(RECIPIENT_ID)

    const patch = mockUpsertPolicyState.mock.calls[0][2]
    expect(patch.rolling24hCount).toBe(3)
    expect(patch.lastProactiveSentAt).toBeInstanceOf(Date)
  })

  it('resets 24h window and sets count to 1 when window has expired', async () => {
    mockFindPolicyState.mockResolvedValue(makeState({
      rolling24hCount:      7,
      rolling24hWindowStart: new Date(Date.now() - WINDOW_24H_MS - 1000), // expired
    }))
    mockUpsertPolicyState.mockResolvedValue(makeState())

    await recordProactiveSent(RECIPIENT_ID)

    const patch = mockUpsertPolicyState.mock.calls[0][2]
    expect(patch.rolling24hCount).toBe(1)
    // New window start should be close to now
    expect(patch.rolling24hWindowStart.getTime()).toBeGreaterThan(Date.now() - 5000)
  })

  it('increments proactiveCount7d within active 7d window', async () => {
    mockFindPolicyState.mockResolvedValue(makeState({ proactiveCount7d: 4 }))
    mockUpsertPolicyState.mockResolvedValue(makeState())

    await recordProactiveSent(RECIPIENT_ID)

    const patch = mockUpsertPolicyState.mock.calls[0][2]
    expect(patch.proactiveCount7d).toBe(5)
  })

  it('resets 7d window counts when 7d window has expired', async () => {
    mockFindPolicyState.mockResolvedValue(makeState({
      proactiveCount7d:  10,
      inboundReplies7d:  5,
      window7dStartedAt: new Date(Date.now() - WINDOW_7D_MS - 1000), // expired
    }))
    mockUpsertPolicyState.mockResolvedValue(makeState())

    await recordProactiveSent(RECIPIENT_ID)

    const patch = mockUpsertPolicyState.mock.calls[0][2]
    expect(patch.proactiveCount7d).toBe(1)
    expect(patch.inboundReplies7d).toBe(0)
  })

  it('creates a row for a first-time recipient (no prior state)', async () => {
    mockFindPolicyState.mockResolvedValue(null)
    mockUpsertPolicyState.mockResolvedValue(makeState())

    await recordProactiveSent(RECIPIENT_ID)

    expect(mockUpsertPolicyState).toHaveBeenCalledOnce()
    const patch = mockUpsertPolicyState.mock.calls[0][2]
    expect(patch.rolling24hCount).toBe(1)
    expect(patch.lastProactiveSentAt).toBeInstanceOf(Date)
  })
})

// ── Tests: recordInboundReply ─────────────────────────────────────────────────

describe('recordInboundReply', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  it('increments inboundReplies7d within active window', async () => {
    mockFindPolicyState.mockResolvedValue(makeState({ inboundReplies7d: 2, proactiveCount7d: 5 }))
    mockUpsertPolicyState.mockResolvedValue(makeState())

    await recordInboundReply(RECIPIENT_ID)

    const patch = mockUpsertPolicyState.mock.calls[0][2]
    expect(patch.inboundReplies7d).toBe(3)
  })

  it('resets 7d window when expired and sets reply count to 1', async () => {
    mockFindPolicyState.mockResolvedValue(makeState({
      inboundReplies7d:  10,
      proactiveCount7d:  10,
      window7dStartedAt: new Date(Date.now() - WINDOW_7D_MS - 1000), // expired
    }))
    mockUpsertPolicyState.mockResolvedValue(makeState())

    await recordInboundReply(RECIPIENT_ID)

    const patch = mockUpsertPolicyState.mock.calls[0][2]
    expect(patch.inboundReplies7d).toBe(1)
    expect(patch.proactiveCount7d).toBe(0)
  })

  it('creates a row for a first-time recipient (no prior state)', async () => {
    mockFindPolicyState.mockResolvedValue(null)
    mockUpsertPolicyState.mockResolvedValue(makeState())

    await recordInboundReply(RECIPIENT_ID)

    expect(mockUpsertPolicyState).toHaveBeenCalledOnce()
    const patch = mockUpsertPolicyState.mock.calls[0][2]
    expect(patch.inboundReplies7d).toBe(1)
  })
})

// ── Tests: recomputeBackoff (via recordProactiveSent / recordInboundReply) ────

describe('recomputeBackoff (via application functions)', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  it('grows spacing by 1.5× when reply rate drops below 30%', async () => {
    // 10 sends, 2 replies = 20% reply rate < 30%
    mockFindPolicyState.mockResolvedValue(makeState({
      proactiveCount7d:        10,
      inboundReplies7d:        2,
      effectiveSpacingMinutes: 90,
    }))
    mockUpsertPolicyState.mockResolvedValue(makeState())

    await recordInboundReply(RECIPIENT_ID)

    const patch = mockUpsertPolicyState.mock.calls[0][2]
    // After reply: proactiveCount7d=10, inboundReplies7d=3 → 30% → resets to floor
    // Exactly 3/10 = 30% which is NOT below threshold, so resets to floor
    expect(patch.effectiveSpacingMinutes).toBe(90)
  })

  it('grows spacing by 1.5× when reply rate is strictly below 30%', async () => {
    // 10 sends, 1 reply = 10% reply rate (after incrementing: 2/10 = 20% < 30%)
    mockFindPolicyState.mockResolvedValue(makeState({
      proactiveCount7d:        10,
      inboundReplies7d:        1,
      effectiveSpacingMinutes: 90,
    }))
    mockUpsertPolicyState.mockResolvedValue(makeState())

    await recordInboundReply(RECIPIENT_ID)

    const patch = mockUpsertPolicyState.mock.calls[0][2]
    // After reply: proactiveCount7d=10, inboundReplies7d=2 → 20% < 30% → backoff
    expect(patch.effectiveSpacingMinutes).toBe(Math.round(90 * 1.5)) // 135
  })

  it('resets spacing to config floor when reply rate is healthy (>= 30%)', async () => {
    // 10 sends, 4 replies → after increment: 5/10 = 50% >= 30%
    mockFindPolicyState.mockResolvedValue(makeState({
      proactiveCount7d:        10,
      inboundReplies7d:        4,
      effectiveSpacingMinutes: 270, // previously backed off
    }))
    mockUpsertPolicyState.mockResolvedValue(makeState())

    await recordInboundReply(RECIPIENT_ID)

    const patch = mockUpsertPolicyState.mock.calls[0][2]
    expect(patch.effectiveSpacingMinutes).toBe(90) // reset to config floor
  })

  it('caps spacing at 2880 minutes (48h) regardless of how many backoffs occur', async () => {
    // Rate stays low; current spacing already near the cap
    mockFindPolicyState.mockResolvedValue(makeState({
      proactiveCount7d:        10,
      inboundReplies7d:        0,
      effectiveSpacingMinutes: 2000, // high but not yet at cap
    }))
    mockUpsertPolicyState.mockResolvedValue(makeState())

    await recordInboundReply(RECIPIENT_ID)

    const patch = mockUpsertPolicyState.mock.calls[0][2]
    // 1/10 = 10% < 30% → 2000 * 1.5 = 3000 → capped at 2880
    expect(patch.effectiveSpacingMinutes).toBe(2880)
  })

  it('does not change spacing when proactiveCount7d is 0 (no sends yet)', async () => {
    mockFindPolicyState.mockResolvedValue(makeState({
      proactiveCount7d:        0,
      inboundReplies7d:        0,
      effectiveSpacingMinutes: 90,
    }))
    mockUpsertPolicyState.mockResolvedValue(makeState())

    await recordInboundReply(RECIPIENT_ID)

    const patch = mockUpsertPolicyState.mock.calls[0][2]
    expect(patch.effectiveSpacingMinutes).toBe(90)
  })
})
