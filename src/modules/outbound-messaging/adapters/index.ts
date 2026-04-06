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
  const response = await fetch('https://a.loopmessage.com/api/v1/message/send/', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': config.LOOPMESSAGE_API_KEY,
    },
    body: JSON.stringify({ contact: to, text: body }),
    signal: AbortSignal.timeout(LOOPMESSAGE_TIMEOUT_MS),
  })

  if (!response.ok) {
    log.error({ event: 'loopmessage.send.failed', correlationId, status: response.status })
    throw new ServiceUnavailableError(
      `LoopMessage sendMessage failed with status ${response.status}`,
    )
  }

  const json = await response.json() as { success?: boolean; message_id?: string }

  if (!json.message_id) {
    throw new ServiceUnavailableError('LoopMessage sendMessage returned no message_id')
  }

  return json.message_id
}
