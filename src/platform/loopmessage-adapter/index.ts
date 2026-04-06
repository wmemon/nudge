import { timingSafeEqual } from 'node:crypto'
import { config } from '../config/index.js'

// ── VID-002 Adapter Contract Note ─────────────────────────────────────────────
//
// Source: https://docs.loopmessage.com/imessage-conversation-api/webhooks
// Confirmed: March 2026
//
// Authentication mechanism:
//   LoopMessage does NOT use HMAC signing. Instead, every inbound webhook POST
//   includes a static shared-secret in a user-configurable header. The header
//   name and value are set once in the LoopMessage dashboard under
//   Webhooks → Authorization Header.
//
//   • Header name  : configured in the dashboard; stored in LOOPMESSAGE_WEBHOOK_AUTH_HEADER
//   • Header value : the raw secret string; stored in LOOPMESSAGE_WEBHOOK_SECRET
//   • Algorithm    : none — static bearer comparison (constant-time)
//   • Body signing : none — the raw body is NOT signed
//   • Replay guard : none built into the protocol; webhook_id dedupe covers retries
//
// Deduplication key:
//   Field: webhook_id (String, UUID) — present in every webhook payload.
//   Use this as the idempotency key in the webhook_events table.
//   (message_id tracks the outbound message, not the webhook delivery event.)
//
// Fixed headers LoopMessage always sends:
//   Content-Type: application/json
//   User-Agent: LoopCampaign
//   Connection: close
//
// ─────────────────────────────────────────────────────────────────────────────

export interface IncomingHeaders {
  [key: string]: string | string[] | undefined
}

/**
 * Verifies the shared-secret authorization header on an incoming LoopMessage webhook.
 *
 * Returns false (never throws) for invalid/missing auth so the route handler
 * can decide the HTTP response.
 *
 * @param _rawBody - Preserved raw request body (not used for auth; kept for interface stability)
 * @param headers  - Request headers; must contain the configured auth header
 */
export function verifyWebhookSignature(
  _rawBody: Buffer,
  headers: IncomingHeaders,
): boolean {
  const secret = config.LOOPMESSAGE_WEBHOOK_SECRET
  if (!secret) return false

  const headerName = config.LOOPMESSAGE_WEBHOOK_AUTH_HEADER.toLowerCase()
  const raw = headers[headerName]
  const incoming = Array.isArray(raw) ? raw[0] : raw
  if (!incoming) return false

  const expected = Buffer.from(secret, 'utf8')
  const actual = Buffer.from(incoming, 'utf8')

  // timingSafeEqual requires identical byte lengths; different lengths = mismatch
  if (expected.byteLength !== actual.byteLength) return false

  return timingSafeEqual(expected, actual)
}

const LOOPMESSAGE_TIMEOUT_MS = 10_000

/**
 * Sends an outbound iMessage via the LoopMessage API.
 *
 * Returns the provider message_id on success.
 * Throws on non-2xx so callers can handle failure (retry or surface error).
 * Content is never logged (OAC-002).
 *
 * Note: outbound-messaging module uses its own adapter with idempotency tracking
 * for conversational sends. This platform-level function is used for transactional
 * sends (e.g. OTP delivery) where the module handles idempotency itself.
 *
 * @param to   - Recipient phone number (E.164) or iCloud email
 * @param body - Message text content
 */
export async function sendMessage(
  to: string,
  body: string,
): Promise<string> {
  const response = await fetch('https://api.loopmessage.com/message/send', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${config.LOOPMESSAGE_API_KEY}`,
    },
    body: JSON.stringify({ recipient: to, text: body }),
    signal: AbortSignal.timeout(LOOPMESSAGE_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`LoopMessage sendMessage failed with HTTP ${response.status.toString()}`)
  }

  const json = await response.json() as { success?: boolean; message_id?: string }
  if (!json.message_id) {
    throw new Error('LoopMessage sendMessage returned no message_id')
  }

  return json.message_id
}
