import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Config mock ───────────────────────────────────────────────────────────────

vi.mock('../../src/platform/config/index.js', () => ({
  config: { LOOPMESSAGE_API_KEY: 'test-api-key' },
}))

// Suppress log noise
vi.mock('../../src/platform/observability/index.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

// ── Data-access mocks ─────────────────────────────────────────────────────────

const mockFindSendIntent                   = vi.fn()
const mockInsertSendIntent                 = vi.fn()
const mockInsertOutboundMessage            = vi.fn()
const mockStampSendIntentProviderMessageId = vi.fn()
const mockMarkSendIntentDelivered          = vi.fn()

vi.mock('../../src/modules/outbound-messaging/data-access/index.js', () => ({
  findSendIntent:                   mockFindSendIntent,
  insertSendIntent:                 mockInsertSendIntent,
  insertOutboundMessage:            mockInsertOutboundMessage,
  stampSendIntentProviderMessageId: mockStampSendIntentProviderMessageId,
  markSendIntentDelivered:          mockMarkSendIntentDelivered,
}))

// ── Adapter mock (LoopMessage HTTP boundary) ──────────────────────────────────

const mockSendMessage = vi.fn()

vi.mock('../../src/modules/outbound-messaging/adapters/index.js', () => ({
  sendMessage: mockSendMessage,
}))

// ── Supabase client mock ──────────────────────────────────────────────────────

vi.mock('../../src/platform/db-supabase/index.js', () => ({
  getSupabaseClient: vi.fn(() => ({})),
}))

// ── Imports after mocks ───────────────────────────────────────────────────────

const { sendOutboundMessage } = await import('../../src/modules/outbound-messaging/index.js')

// ── Fixtures ──────────────────────────────────────────────────────────────────

const RECIPIENT_ID    = '00000000-0000-0000-0000-000000000001'
const HANDLE          = '+13231112233'
const BODY            = "Hey! Just checking in on your goal — how's it going today? 💪"
const IDEMPOTENCY_KEY = 'checkin:00000000-0000-0000-0000-000000000001:2026-04-01T09:00:00.000Z'
const CORRELATION_ID  = 'corr-abc-123'
const PROVIDER_MSG_ID = 'loop-msg-id-xyz'

function makePendingIntent(providerMessageId: string | null = null) {
  return {
    id:               '00000000-0000-0000-0000-000000000010',
    recipientId:      RECIPIENT_ID,
    idempotencyKey:   IDEMPOTENCY_KEY,
    status:           'pending' as const,
    providerMessageId,
    createdAt:        new Date(),
    updatedAt:        new Date(),
  }
}

function makeDeliveredIntent() {
  return { ...makePendingIntent(PROVIDER_MSG_ID), status: 'delivered' as const }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sendOutboundMessage (AIC-003 idempotency)', () => {
  beforeEach(() => {
    mockFindSendIntent.mockResolvedValue(null)
    mockInsertSendIntent.mockResolvedValue(makePendingIntent())
    mockSendMessage.mockResolvedValue(PROVIDER_MSG_ID)
    mockStampSendIntentProviderMessageId.mockResolvedValue(undefined)
    mockInsertOutboundMessage.mockResolvedValue(undefined)
    mockMarkSendIntentDelivered.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  // ── Test 1: happy path ─────────────────────────────────────────────────────

  it('sends message and records full intent lifecycle on first call', async () => {
    await sendOutboundMessage(RECIPIENT_ID, HANDLE, BODY, IDEMPOTENCY_KEY, CORRELATION_ID)

    expect(mockInsertSendIntent).toHaveBeenCalledOnce()
    expect(mockSendMessage).toHaveBeenCalledWith(HANDLE, BODY, CORRELATION_ID)
    expect(mockStampSendIntentProviderMessageId).toHaveBeenCalledWith(
      expect.anything(), IDEMPOTENCY_KEY, PROVIDER_MSG_ID,
    )
    expect(mockInsertOutboundMessage).toHaveBeenCalledWith(
      expect.anything(), RECIPIENT_ID, BODY, PROVIDER_MSG_ID,
    )
    expect(mockMarkSendIntentDelivered).toHaveBeenCalledWith(
      expect.anything(), IDEMPOTENCY_KEY, PROVIDER_MSG_ID,
    )
  })

  // ── Test 2: already delivered → no-op ─────────────────────────────────────

  it('returns early without sending when intent is already delivered (retry no-op)', async () => {
    mockFindSendIntent.mockResolvedValue(makeDeliveredIntent())

    await sendOutboundMessage(RECIPIENT_ID, HANDLE, BODY, IDEMPOTENCY_KEY, CORRELATION_ID)

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockInsertSendIntent).not.toHaveBeenCalled()
    expect(mockInsertOutboundMessage).not.toHaveBeenCalled()
    expect(mockMarkSendIntentDelivered).not.toHaveBeenCalled()
  })

  // ── Test 3: pending intent exists → skips insert, still sends ─────────────

  it('skips insertSendIntent but still sends when a pending intent already exists', async () => {
    mockFindSendIntent.mockResolvedValue(makePendingIntent())

    await sendOutboundMessage(RECIPIENT_ID, HANDLE, BODY, IDEMPOTENCY_KEY, CORRELATION_ID)

    expect(mockInsertSendIntent).not.toHaveBeenCalled()
    expect(mockSendMessage).toHaveBeenCalledOnce()
    expect(mockMarkSendIntentDelivered).toHaveBeenCalledOnce()
  })

  // ── Test 4: crash-safety — providerMessageId already stamped ──────────────

  it('skips the send API call when providerMessageId is already stamped (crash-safe retry)', async () => {
    mockFindSendIntent.mockResolvedValue(makePendingIntent(PROVIDER_MSG_ID))

    await sendOutboundMessage(RECIPIENT_ID, HANDLE, BODY, IDEMPOTENCY_KEY, CORRELATION_ID)

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockInsertOutboundMessage).toHaveBeenCalledWith(
      expect.anything(), RECIPIENT_ID, BODY, PROVIDER_MSG_ID,
    )
    expect(mockMarkSendIntentDelivered).toHaveBeenCalledOnce()
  })

  // ── Test 5: LoopMessage failure propagates for BullMQ retry ───────────────

  it('propagates LoopMessage errors so BullMQ retries the job (TRC-001)', async () => {
    mockSendMessage.mockRejectedValue(new Error('LoopMessage unavailable'))

    await expect(
      sendOutboundMessage(RECIPIENT_ID, HANDLE, BODY, IDEMPOTENCY_KEY, CORRELATION_ID),
    ).rejects.toThrow('LoopMessage unavailable')

    expect(mockMarkSendIntentDelivered).not.toHaveBeenCalled()
  })
})
