// VID-003: LoopMessage payload parsing and normalization stays inside this file.
// Nothing below this boundary ever sees raw LoopMessage field names.
//
// Confirmed payload fields (docs.loopmessage.com/imessage-conversation-api/webhooks):
//   webhook_id   — UUID; deduplication key
//   event        — event type string; "message_inbound" for inbound messages
//   contact      — sender's E.164 phone or iCloud email
//   text         — message body; may be absent/null on image-only messages
//   message_type — e.g. "text", "attachments", "audio", "reaction" (optional)
//   attachments  — array of download URLs; present when message_type is "attachments" (optional)

import { z } from 'zod'
import { parseOrThrow } from '../../../shared/validation/index.js'

// ── Vendor payload schema (VID-001: validate at ingress) ──────────────────────
// Unknown fields are stripped by Zod's default object behaviour (VID-003).

const LoopMessageWebhookPayloadSchema = z.object({
  webhook_id:   z.string(),
  event:        z.string(),
  contact:      z.string(),
  text:         z.string().nullish(),
  message_type: z.string().optional(),
})

// ── Internal normalized type ───────────────────────────────────────────────────

export interface NormalizedInboundEvent {
  /** LoopMessage webhook_id — deduplication key */
  webhookId: string
  /** LoopMessage event type, e.g. "message_inbound" */
  event: string
  /** Sender's E.164 phone or iCloud email (maps from LoopMessage "contact") */
  recipientHandle: string
  /** Message body text; empty string for image-only messages */
  text: string
}

// ── Normalizer ────────────────────────────────────────────────────────────────

/**
 * Validates and normalizes a raw LoopMessage webhook body into an internal type.
 * Throws ValidationError (→ 400) if required fields are missing or malformed.
 */
export function normalizeLoopMessagePayload(body: unknown): NormalizedInboundEvent {
  const payload = parseOrThrow(LoopMessageWebhookPayloadSchema, body)
  return {
    webhookId:       payload.webhook_id,
    event:           payload.event,
    recipientHandle: payload.contact,
    text:            payload.text ?? '',
  }
}
