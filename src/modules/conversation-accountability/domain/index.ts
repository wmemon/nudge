// E-MESSAGE — inbound/outbound message record for accountability and export.
// E-NLU-OUTCOME — structured accountability facts derived from the LLM path.
// Both owned by conversation-accountability (data-model-and-ownership §4).

export interface Message {
  id: string
  recipientId: string
  direction: 'inbound' | 'outbound'
  body: string
  hasImageAttachment: boolean
  providerMessageId: string | null
  createdAt: Date
}

export interface NluOutcome {
  id: string
  recipientId: string
  messageId: string
  outcomeType: string
  classification: 'done' | 'not_done' | 'unclear'
  confidence: number | null
  createdAt: Date
}
