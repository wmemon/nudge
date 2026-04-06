// E-WEBHOOK-EVENT — durable idempotency record for inbound LoopMessage webhook deliveries.
// Insert-once semantics; immutable after write. (data-model-and-ownership §4)

export interface WebhookEvent {
  /** Internal primary key (UUID) */
  id: string
  /** LoopMessage webhook_id field — used as the deduplication key (VID-002) */
  webhookId: string
  /** When the webhook POST was received by the API */
  receivedAt: Date
  /** When the continuation job was successfully enqueued; null until then */
  processedAt: Date | null
}
