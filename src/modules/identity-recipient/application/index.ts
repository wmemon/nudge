import { getSupabaseClient } from '../../../platform/db-supabase/index.js'
import { findById, findByHandle, markOnboardingComplete as markOnboardingCompleteInDb, setGloballyPaused, upsertRecipient } from '../data-access/index.js'
import type { Recipient } from '../domain/index.js'

/**
 * Resolves a stable Recipient record for the given LoopMessage handle.
 * Creates a new record on first encounter; returns the existing one on repeat.
 *
 * This is the single entry point for recipient identity resolution (DDC-001).
 * All inbound pipeline jobs call this before any business logic.
 */
/**
 * Returns a Recipient by internal id, or null if not found.
 * Used by worker job handlers that have a recipientId but not a handle.
 */
export async function findRecipientById(recipientId: string): Promise<Recipient | null> {
  const supabase = getSupabaseClient()
  return findById(supabase, recipientId)
}

/**
 * Returns a Recipient by handle, or null if not found.
 * Used by flows that have a handle but no recipientId (e.g. OTP verification).
 * DDC-003: always scoped to a single handle.
 */
export async function findRecipientByHandle(handle: string): Promise<Recipient | null> {
  const supabase = getSupabaseClient()
  return findByHandle(supabase, handle)
}

export async function findOrCreateRecipient(handle: string): Promise<Recipient> {
  const supabase = getSupabaseClient()
  return upsertRecipient(supabase, handle)
}

/**
 * Marks the recipient's onboarding as complete.
 * Called once after a goal is successfully captured (Q3.R2).
 * Idempotent — safe to call on retry.
 */
export async function markOnboardingComplete(recipientId: string): Promise<void> {
  const supabase = getSupabaseClient()
  await markOnboardingCompleteInDb(supabase, recipientId)
}

/**
 * Sets globally_paused = true for the given recipient, stopping all automated
 * outbound messages (Q3.R3 — 7-day abandonment stop).
 *
 * Single write-authority path for globally_paused (DDC-001).
 * Called by abandonment-lifecycle; must not be called from any other module.
 * Idempotent — safe to call if already paused.
 *
 * NOTE: paused recipients can still send inbound messages and receive stored
 * responses — only automated proactive outbound is blocked. The inbound
 * pipeline does not check globally_paused (Q3.R3 intent).
 *
 * TODO: add resumeRecipient() when auto-resume-on-new-inbound is implemented.
 */
export async function pauseRecipient(recipientId: string): Promise<void> {
  const supabase = getSupabaseClient()
  await setGloballyPaused(supabase, recipientId, true)
}
