import type { SupabaseClient } from '../../../platform/db-supabase/index.js'
import { InternalError } from '../../../shared/errors/index.js'
import type { Message, NluOutcome } from '../domain/index.js'

// ── Row mappers ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toMessage(row: Record<string, any>): Message {
  return {
    id:                  row.id as string,
    recipientId:         row.recipient_id as string,
    direction:           row.direction as 'inbound' | 'outbound',
    body:                row.body as string,
    hasImageAttachment:  row.has_image_attachment as boolean,
    providerMessageId:   row.provider_message_id as string | null,
    createdAt:           new Date(row.created_at as string),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toNluOutcome(row: Record<string, any>): NluOutcome {
  return {
    id:             row.id as string,
    recipientId:    row.recipient_id as string,
    messageId:      row.message_id as string,
    outcomeType:    row.outcome_type as string,
    classification: row.classification as 'done' | 'not_done' | 'unclear',
    confidence:     row.confidence as number | null,
    createdAt:      new Date(row.created_at as string),
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Returns the most recent N messages for a recipient, oldest-first.
 * Used to build conversation history for LLM context.
 * DDC-003: always scoped to a single recipientId.
 */
export async function fetchRecentMessages(
  supabase: SupabaseClient,
  recipientId: string,
  limit: number,
): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('recipient_id', recipientId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw new InternalError(`fetchRecentMessages failed: ${error.message}`)

  // Reverse so messages are in chronological order (oldest first) for LLM context
  return (data ?? []).map(toMessage).reverse()
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Inserts a message row and returns the persisted record.
 * DDC-003: always scoped to a single recipientId.
 * Content is not logged by callers (OAC-002).
 */
export async function insertMessage(
  supabase: SupabaseClient,
  recipientId: string,
  direction: 'inbound' | 'outbound',
  body: string,
  opts?: { hasImageAttachment?: boolean; providerMessageId?: string },
): Promise<Message> {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      recipient_id:          recipientId,
      direction,
      body,
      has_image_attachment:  opts?.hasImageAttachment ?? false,
      provider_message_id:   opts?.providerMessageId ?? null,
    })
    .select('*')
    .single()

  if (error) throw new InternalError(`insertMessage failed: ${error.message}`)
  if (!data)  throw new InternalError('insertMessage returned no row')

  return toMessage(data)
}

/**
 * Inserts an NLU outcome row linked to a message and returns the persisted record.
 * DDC-003: scoped to a single recipientId.
 */
export async function insertNluOutcome(
  supabase: SupabaseClient,
  recipientId: string,
  messageId: string,
  outcome: { outcomeType: string; classification: 'done' | 'not_done' | 'unclear'; confidence?: number },
): Promise<NluOutcome> {
  const { data, error } = await supabase
    .from('nlu_outcomes')
    .insert({
      recipient_id:   recipientId,
      message_id:     messageId,
      outcome_type:   outcome.outcomeType,
      classification: outcome.classification,
      confidence:     outcome.confidence ?? null,
    })
    .select('*')
    .single()

  if (error) throw new InternalError(`insertNluOutcome failed: ${error.message}`)
  if (!data)  throw new InternalError('insertNluOutcome returned no row')

  return toNluOutcome(data)
}
