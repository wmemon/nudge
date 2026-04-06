import type { SupabaseClient } from '../../../platform/db-supabase/index.js'
import { InternalError } from '../../../shared/errors/index.js'
import type { Recipient } from '../domain/index.js'

// ── Row mapper ────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRecipient(row: Record<string, any>): Recipient {
  return {
    id:                 row.id as string,
    handle:             row.handle as string,
    firstSeenAt:        new Date(row.first_seen_at as string),
    onboardingComplete: row.onboarding_complete as boolean,
    quietHoursTz:       row.quiet_hours_tz as string | null,
    globallyPaused:     row.globally_paused as boolean,
    createdAt:          new Date(row.created_at as string),
    updatedAt:          new Date(row.updated_at as string),
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * Returns the recipient with the given id, or null if not found.
 * DDC-003: scoped to a single recipientId.
 */
export async function findById(
  supabase: SupabaseClient,
  recipientId: string,
): Promise<Recipient | null> {
  const { data, error } = await supabase
    .from('recipients')
    .select('*')
    .eq('id', recipientId)
    .maybeSingle()

  if (error) throw new InternalError(`findById failed: ${error.message}`)
  return data ? toRecipient(data) : null
}

/**
 * Returns the recipient with the given handle, or null if not found.
 * DDC-003: always scoped by handle — never returns rows for other recipients.
 */
export async function findByHandle(
  supabase: SupabaseClient,
  handle: string,
): Promise<Recipient | null> {
  const { data, error } = await supabase
    .from('recipients')
    .select('*')
    .eq('handle', handle)
    .maybeSingle()

  if (error) throw new InternalError(`findByHandle failed: ${error.message}`)
  if (!data) return null

  return toRecipient(data)
}

/**
 * Sets onboarding_complete = true for the given recipient.
 * Idempotent — safe to call multiple times (Q3.R2).
 * DDC-003: scoped to a single recipientId.
 */
export async function markOnboardingComplete(
  supabase: SupabaseClient,
  recipientId: string,
): Promise<void> {
  const { error } = await supabase
    .from('recipients')
    .update({ onboarding_complete: true, updated_at: new Date().toISOString() })
    .eq('id', recipientId)

  if (error) throw new InternalError(`markOnboardingComplete failed: ${error.message}`)
}

/**
 * Sets globally_paused on the recipient to the given value.
 * Idempotent — safe to call multiple times.
 * DDC-001: single write-authority path for globally_paused (called via pauseRecipient in application).
 * DDC-003: scoped to a single recipientId.
 */
export async function setGloballyPaused(
  supabase: SupabaseClient,
  recipientId: string,
  paused: boolean,
): Promise<void> {
  const { error } = await supabase
    .from('recipients')
    .update({ globally_paused: paused, updated_at: new Date().toISOString() })
    .eq('id', recipientId)

  if (error) throw new InternalError(`setGloballyPaused failed: ${error.message}`)
}

/**
 * Inserts a new recipient for the given handle, or returns the existing one
 * if it already exists (upsert on conflict). Sets updated_at = now() on conflict
 * so the row is always fresh after this call.
 * DDC-003: scoped to a single handle.
 */
export async function upsertRecipient(
  supabase: SupabaseClient,
  handle: string,
): Promise<Recipient> {
  const { data, error } = await supabase
    .from('recipients')
    .upsert(
      { handle, updated_at: new Date().toISOString() },
      { onConflict: 'handle', ignoreDuplicates: false },
    )
    .select('*')
    .single()

  if (error) throw new InternalError(`upsertRecipient failed: ${error.message}`)
  if (!data) throw new InternalError('upsertRecipient returned no row')

  return toRecipient(data)
}
