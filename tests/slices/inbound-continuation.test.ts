import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Job } from 'bullmq'
import type { LLMResponse, OnboardingResponse } from '../../src/platform/llm-router/index.js'

// ── Config mock (mutable so individual tests can override values) ─────────────

const mockConfig = {
  NODE_ENV:               'test' as string,
  LLM_CALLS_ENABLED:      true,
  LOOPMESSAGE_ALLOWLIST:  '',
}

vi.mock('../../src/platform/config/index.js', () => ({ config: mockConfig }))

// ── External boundary mocks ───────────────────────────────────────────────────

vi.mock('../../src/modules/identity-recipient/index.js', () => ({
  findOrCreateRecipient: vi.fn(),
  markOnboardingComplete: vi.fn(),
}))

const mockComplete = vi.fn()
const mockCompleteOnboarding = vi.fn()
vi.mock('../../src/platform/llm-router/index.js', () => ({
  createLLMRouter: vi.fn(() => ({
    complete:             mockComplete,
    completeOnboarding:   mockCompleteOnboarding,
  })),
}))

vi.mock('../../src/modules/conversation-accountability/index.js', () => ({
  processInboundTurn:      vi.fn(),
  getConversationHistory:  vi.fn(),
}))

vi.mock('../../src/modules/outbound-messaging/index.js', () => ({
  sendOutboundMessage: vi.fn(),
}))

const mockGetActiveGoal = vi.fn()
const mockCaptureGoal   = vi.fn()
vi.mock('../../src/modules/goal-scheduling/index.js', () => ({
  getActiveGoal: mockGetActiveGoal,
  captureGoal:   mockCaptureGoal,
}))

vi.mock('../../src/modules/proactive-policy/index.js', () => ({
  recordInboundReply: vi.fn(),
}))

// Suppress log noise in test output (OAC-002 — content never logged anyway)
vi.mock('../../src/platform/observability/index.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

// ── Imports after mocks ───────────────────────────────────────────────────────

const { handleInboundContinuation } = await import('../../src/modules/webhook-ingestion/index.js')
const { findOrCreateRecipient, markOnboardingComplete } = await import('../../src/modules/identity-recipient/index.js')
const { processInboundTurn, getConversationHistory }   = await import('../../src/modules/conversation-accountability/index.js')
const { sendOutboundMessage }                          = await import('../../src/modules/outbound-messaging/index.js')
const { captureGoal }                                  = await import('../../src/modules/goal-scheduling/index.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJob(data: Record<string, unknown>, id = 'job-001'): Job {
  return { id, data } as unknown as Job
}

const VALID_PAYLOAD = {
  webhookId:       'wh-uuid-001',
  recipientHandle: '+13231112233',
  text:            'I went to the gym today!',
  correlationId:   'req-abc-123',
}

const MOCK_RECIPIENT = {
  id:                 'recipient-uuid-001',
  handle:             '+13231112233',
  firstSeenAt:        new Date(),
  onboardingComplete: false,
  quietHoursTz:       null,
  globallyPaused:     false,
  createdAt:          new Date(),
  updatedAt:          new Date(),
}

const MOCK_GOAL = {
  id:            'goal-uuid-001',
  recipientId:   'recipient-uuid-001',
  text:          'Exercise 3 times a week',
  active:        true,
  deactivatedAt: null,
  createdAt:     new Date(),
  updatedAt:     new Date(),
}

function makeLLMResponse(): LLMResponse {
  return {
    content:    'Great job! Keep it up.',
    nluOutcome: { outcomeType: 'accountability_check', classification: 'done', confidence: 0.9 },
    usage:      { promptTokens: 10, completionTokens: 20 },
  }
}

function makeOnboardingResponse(goalDetected = false): OnboardingResponse {
  return {
    content: 'What goal would you like to work on?',
    goalCapture: {
      detected:    goalDetected,
      goalText:    goalDetected ? 'Exercise 3 times a week' : '',
      checkInTime: goalDetected ? '09:00' : '',
      timezone:    goalDetected ? 'America/New_York' : '',
    },
    nluOutcome: { outcomeType: 'onboarding', classification: 'unclear' },
    usage:      { promptTokens: 10, completionTokens: 20 },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleInboundContinuation (JOB-INBOUND-001)', () => {
  beforeEach(() => {
    // Reset config to safe defaults before each test
    mockConfig.NODE_ENV              = 'test'
    mockConfig.LLM_CALLS_ENABLED     = true
    mockConfig.LOOPMESSAGE_ALLOWLIST = ''

    vi.mocked(findOrCreateRecipient).mockResolvedValue(MOCK_RECIPIENT)
    // Default: accountability mode — active goal exists
    mockGetActiveGoal.mockResolvedValue(MOCK_GOAL)
    mockComplete.mockResolvedValue(makeLLMResponse())
    mockCompleteOnboarding.mockResolvedValue(makeOnboardingResponse(false))
    vi.mocked(getConversationHistory).mockResolvedValue([])
    vi.mocked(processInboundTurn).mockResolvedValue({} as never)
    vi.mocked(sendOutboundMessage).mockResolvedValue(undefined)
    vi.mocked(captureGoal).mockResolvedValue(MOCK_GOAL as never)
    vi.mocked(markOnboardingComplete).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  // ── Test 1: happy path (accountability mode) ───────────────────────────────

  it('runs the full pipeline and sends a reply on valid payload', async () => {
    await handleInboundContinuation(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(findOrCreateRecipient)).toHaveBeenCalledOnce()
    expect(mockComplete).toHaveBeenCalledOnce()
    expect(vi.mocked(processInboundTurn)).toHaveBeenCalledOnce()
    expect(vi.mocked(sendOutboundMessage)).toHaveBeenCalledOnce()
  })

  // ── Test 2: LLM disabled ───────────────────────────────────────────────────

  it('resolves recipient but skips LLM and send when LLM_CALLS_ENABLED is false', async () => {
    mockConfig.LLM_CALLS_ENABLED = false

    await handleInboundContinuation(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(findOrCreateRecipient)).toHaveBeenCalledOnce()
    expect(mockComplete).not.toHaveBeenCalled()
    expect(mockCompleteOnboarding).not.toHaveBeenCalled()
    expect(vi.mocked(processInboundTurn)).not.toHaveBeenCalled()
    expect(vi.mocked(sendOutboundMessage)).not.toHaveBeenCalled()
  })

  // ── Test 3: invalid payload ────────────────────────────────────────────────

  it('throws on missing required fields so BullMQ marks the job failed (VID-001)', async () => {
    const badPayload = { webhookId: 'wh-001', text: 'hello' } // missing recipientHandle + correlationId

    await expect(handleInboundContinuation(makeJob(badPayload))).rejects.toThrow()

    expect(vi.mocked(findOrCreateRecipient)).not.toHaveBeenCalled()
    expect(vi.mocked(sendOutboundMessage)).not.toHaveBeenCalled()
  })

  // ── Test 4: allowlist block ────────────────────────────────────────────────

  it('returns early without sending when handle is not on the allowlist in non-production', async () => {
    mockConfig.NODE_ENV              = 'development'
    mockConfig.LOOPMESSAGE_ALLOWLIST = '+19990000001,+19990000002' // our handle is not in this list

    await handleInboundContinuation(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(findOrCreateRecipient)).not.toHaveBeenCalled()
    expect(vi.mocked(sendOutboundMessage)).not.toHaveBeenCalled()
  })

  // ── Test 5: empty allowlist passes all handles ─────────────────────────────

  it('proceeds normally when LOOPMESSAGE_ALLOWLIST is empty in non-production (DPC-004)', async () => {
    mockConfig.NODE_ENV              = 'development'
    mockConfig.LOOPMESSAGE_ALLOWLIST = '' // empty = no restriction

    await handleInboundContinuation(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(sendOutboundMessage)).toHaveBeenCalledOnce()
  })

  // ── Test 6: allowlist skipped in production ────────────────────────────────

  it('skips allowlist check entirely in production and sends', async () => {
    mockConfig.NODE_ENV              = 'production'
    mockConfig.LOOPMESSAGE_ALLOWLIST = '+19990000001' // handle not in list — should be ignored

    await handleInboundContinuation(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(sendOutboundMessage)).toHaveBeenCalledOnce()
  })

  // ── Test 7: idempotency key shape ──────────────────────────────────────────

  it('calls sendOutboundMessage with idempotency key = webhookId + ":reply"', async () => {
    await handleInboundContinuation(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(sendOutboundMessage)).toHaveBeenCalledWith(
      expect.any(String),
      VALID_PAYLOAD.recipientHandle,
      expect.any(String),
      `${VALID_PAYLOAD.webhookId}:reply`,
      expect.any(String),
    )
  })

  // ── Test 8: uses recipientId (not handle) for downstream calls (DDC-003) ───

  it('passes recipient.id (internal UUID) to processInboundTurn and sendOutboundMessage', async () => {
    await handleInboundContinuation(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(processInboundTurn)).toHaveBeenCalledWith(
      MOCK_RECIPIENT.id,
      VALID_PAYLOAD.text,
      expect.any(Object),
    )

    expect(vi.mocked(sendOutboundMessage)).toHaveBeenCalledWith(
      MOCK_RECIPIENT.id,
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    )
  })

  // ── Test 9: LLM throws → error propagates for retry (TRC-001) ─────────────

  it('propagates LLM errors so BullMQ retries the job (TRC-001)', async () => {
    mockComplete.mockRejectedValue(new Error('OpenRouter unavailable'))

    await expect(handleInboundContinuation(makeJob(VALID_PAYLOAD))).rejects.toThrow('OpenRouter unavailable')

    expect(vi.mocked(sendOutboundMessage)).not.toHaveBeenCalled()
  })

  // ── Test 10: sendOutboundMessage throws → error propagates for retry (TRC-001) ──

  it('propagates send errors so BullMQ retries the job (TRC-001)', async () => {
    vi.mocked(sendOutboundMessage).mockRejectedValue(new Error('LoopMessage unavailable'))

    await expect(handleInboundContinuation(makeJob(VALID_PAYLOAD))).rejects.toThrow('LoopMessage unavailable')
  })

  // ── Test 11: onboarding mode — no goal detected yet ───────────────────────

  it('uses completeOnboarding (not complete) when recipient has no active goal', async () => {
    mockGetActiveGoal.mockResolvedValue(null)

    await handleInboundContinuation(makeJob(VALID_PAYLOAD))

    expect(mockCompleteOnboarding).toHaveBeenCalledOnce()
    expect(mockComplete).not.toHaveBeenCalled()
    expect(vi.mocked(captureGoal)).not.toHaveBeenCalled()
    expect(vi.mocked(markOnboardingComplete)).not.toHaveBeenCalled()
    expect(vi.mocked(sendOutboundMessage)).toHaveBeenCalledOnce()
  })

  // ── Test 12: onboarding mode — goal detected → persist + mark complete ─────

  it('captures goal and marks onboarding complete when LLM detects goal during onboarding', async () => {
    mockGetActiveGoal.mockResolvedValue(null)
    mockCompleteOnboarding.mockResolvedValue(makeOnboardingResponse(true))

    await handleInboundContinuation(makeJob(VALID_PAYLOAD))

    expect(vi.mocked(captureGoal)).toHaveBeenCalledOnce()
    expect(vi.mocked(captureGoal)).toHaveBeenCalledWith(
      MOCK_RECIPIENT.id,
      expect.objectContaining({
        goalText:    'Exercise 3 times a week',
        checkInTime: '09:00',
        timezone:    'America/New_York',
      }),
    )
    expect(vi.mocked(markOnboardingComplete)).toHaveBeenCalledWith(MOCK_RECIPIENT.id)
    expect(vi.mocked(sendOutboundMessage)).toHaveBeenCalledOnce()
  })

  // ── Test 13: accountability mode uses complete, not completeOnboarding ─────

  it('uses complete (not completeOnboarding) when recipient has an active goal', async () => {
    // Default beforeEach already sets getActiveGoal → MOCK_GOAL
    await handleInboundContinuation(makeJob(VALID_PAYLOAD))

    expect(mockComplete).toHaveBeenCalledOnce()
    expect(mockCompleteOnboarding).not.toHaveBeenCalled()
  })
})
