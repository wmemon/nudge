// E-OUTBOUND-SEND-INTENT — idempotency and audit record for externally visible sends.
// Owned by outbound-messaging (data-model-and-ownership §4).

export interface OutboundSendIntent {
  id: string
  recipientId: string
  idempotencyKey: string
  status: 'pending' | 'delivered' | 'failed'
  providerMessageId: string | null
  createdAt: Date
  updatedAt: Date
}
