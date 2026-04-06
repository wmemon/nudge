// VID-002 Adapter Contract Note — LoopMessage Send API
//
// Source: https://docs.loopmessage.com/imessage-conversation-api/send-message.md
// Confirmed: April 2026
//
// Endpoint:  POST https://a.loopmessage.com/api/v1/message/send/
// Auth:      Authorization: <LOOPMESSAGE_API_KEY> (raw key; no Bearer per LoopMessage credentials doc)
// Body:      { "contact": "<E.164 or iCloud email>", "text": "<message body>" }
// Response:  JSON includes message_id on 200; non-2xx on failure — treat as transient; job will retry (AIC-003)
//
// Idempotency: LoopMessage does not expose a native idempotency key on the send
// endpoint. Deduplication is handled by our outbound_send_intents table —
// we check for an existing 'delivered' intent before calling this function.

import { config } from '../../../platform/config/index.js'
import { createLogger } from '../../../platform/observability/index.js'
import { ServiceUnavailableError } from '../../../shared/errors/index.js'

const log = createLogger({ module: 'loopmessage-adapter' })

const LOOPMESSAGE_TIMEOUT_MS = 10_000

/** Single source of truth — logged on failure to verify deploy bundle (debug). */
const LOOPMESSAGE_SEND_URL = 'https://a.loopmessage.com/api/v1/message/send/'

/**
 * Sends an outbound iMessage via the LoopMessage API.
 *
 * Returns the provider message_id on success.
 * Throws ServiceUnavailableError on non-2xx so the BullMQ job retries (AIC-003).
 * Content is never logged (OAC-002).
 */
export async function sendMessage(
  to: string,
  body: string,
  correlationId?: string,
): Promise<string> {
  const response = await fetch(LOOPMESSAGE_SEND_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': config.LOOPMESSAGE_API_KEY,
    },
    body: JSON.stringify({ contact: to, text: body }),
    signal: AbortSignal.timeout(LOOPMESSAGE_TIMEOUT_MS),
  })

  const responseText = await response.text()

  if (!response.ok) {
    const errorBodyPreview = responseText.slice(0, 320)
    let loopMessageErrorCode: number | undefined
    try {
      const parsed = JSON.parse(responseText) as { code?: number }
      if (typeof parsed.code === 'number') loopMessageErrorCode = parsed.code
    } catch {
      /* non-JSON body (e.g. HTML 404 page) */
    }
    log.error({
      event:       'loopmessage.send.failed',
      correlationId,
      status:      response.status,
      sendUrl:     LOOPMESSAGE_SEND_URL,
      errorPreview: errorBodyPreview,
      loopMessageErrorCode,
    })
    // #region agent log
    fetch('http://127.0.0.1:7409/ingest/f87e662c-66d7-447b-b137-66b652dd7ffa', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '2e720c' },
      body:    JSON.stringify({
        sessionId:    '2e720c',
        hypothesisId: 'H1',
        location:     'outbound-messaging/adapters/index.ts:sendMessage',
        message:      'loopmessage send non-ok',
        data:         { status: response.status, sendUrl: LOOPMESSAGE_SEND_URL, errorPreview: errorBodyPreview, loopMessageErrorCode },
        timestamp:    Date.now(),
      }),
    }).catch(() => {})
    // #endregion
    throw new ServiceUnavailableError(
      `LoopMessage sendMessage failed with status ${response.status}`,
    )
  }

  let json: { success?: boolean; message_id?: string }
  try {
    json = JSON.parse(responseText) as { success?: boolean; message_id?: string }
  } catch {
    throw new ServiceUnavailableError('LoopMessage sendMessage returned invalid JSON')
  }

  if (!json.message_id) {
    throw new ServiceUnavailableError('LoopMessage sendMessage returned no message_id')
  }

  return json.message_id
}
