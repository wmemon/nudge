import { getSupabaseClient } from '../../../platform/db-supabase/index.js'
import type { LLMResponse } from '../../../platform/llm-router/index.js'
import { fetchRecentMessages, insertMessage, insertNluOutcome } from '../data-access/index.js'
import type { Message, NluOutcome } from '../domain/index.js'

const HISTORY_LIMIT = 10

/**
 * Returns the last N messages for a recipient as LLM-ready chat turns.
 * Call this BEFORE the LLM call so history does not include the current message.
 * Content is never logged by callers (OAC-002).
 */
export async function getConversationHistory(
  recipientId: string,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const supabase = getSupabaseClient()
  const messages = await fetchRecentMessages(supabase, recipientId, HISTORY_LIMIT)
  return messages.map((m) => ({
    role:    m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.body,
  }))
}

export interface InboundTurnResult {
  message:    Message
  nluOutcome: NluOutcome
}

/**
 * Persists the inbound message and its NLU outcome after the LLM has responded.
 *
 * Call order:
 *   1. Insert inbound message row (E-MESSAGE)
 *   2. Insert NLU outcome row linked to that message (E-NLU-OUTCOME)
 *
 * Content (inboundText, llmResponse.content) is never passed to the logger (OAC-002).
 * recipientId scoping is enforced on every query (DDC-003).
 */
export async function processInboundTurn(
  recipientId: string,
  inboundText: string,
  llmResponse: LLMResponse,
  opts?: { hasImageAttachment?: boolean },
): Promise<InboundTurnResult> {
  const supabase = getSupabaseClient()

  const message = await insertMessage(
    supabase,
    recipientId,
    'inbound',
    inboundText,
    { hasImageAttachment: opts?.hasImageAttachment ?? false },
  )

  const nluOutcome = await insertNluOutcome(
    supabase,
    recipientId,
    message.id,
    {
      outcomeType:    llmResponse.nluOutcome.outcomeType,
      classification: llmResponse.nluOutcome.classification,
      confidence:     llmResponse.nluOutcome.confidence,
    },
  )

  return { message, nluOutcome }
}
