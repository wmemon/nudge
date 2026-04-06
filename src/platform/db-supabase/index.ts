import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Re-export so data-access layers can import the type without violating MBC-003
export type { SupabaseClient }
import { config } from '../config/index.js'

// MBC-003: @supabase/supabase-js is ONLY imported in this file.
// All other modules that need database access must go through this module's exports.

let _client: SupabaseClient | null = null

/**
 * Returns the singleton Supabase client.
 * Uses the service-role key — server-only, never exposed to browser.
 */
export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client
  _client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
  return _client
}

/**
 * Lightweight liveness check — runs SELECT 1.
 * Used by the /ready endpoint (API-HLTH-002).
 * supabase-js is HTTP-based; no explicit connection close needed.
 */
export async function checkDb(): Promise<{ ok: boolean; latencyMs: number }> {
  const client = getSupabaseClient()
  const start = Date.now()
  try {
    const { error } = await client
      .from('webhook_events')
      .select('id')
      .limit(1)
    if (error) {
      return { ok: false, latencyMs: Date.now() - start }
    }
    return { ok: true, latencyMs: Date.now() - start }
  } catch {
    return { ok: false, latencyMs: Date.now() - start }
  }
}
