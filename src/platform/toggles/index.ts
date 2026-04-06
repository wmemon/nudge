import { config } from '../config/index.js'
import { getSupabaseClient } from '../db-supabase/index.js'

// ── Toggle key type ───────────────────────────────────────────────────────────

/** Known operational toggle keys (E-OPERATIONAL-TOGGLE entity) */
export type ToggleKey =
  | 'PROACTIVE_SENDS_ENABLED'
  | 'LLM_CALLS_ENABLED'
  | 'RIGHTS_ENDPOINTS_ENABLED'
  | 'ENFORCE_OUTBOUND_ALLOWLIST'

// ── In-process cache ──────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000 // 30 second TTL

interface CacheEntry {
  value: boolean
  expiresAt: number
}

const _cache = new Map<string, CacheEntry>()

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the current value of an operational toggle.
 *
 * Precedence (ADR §8, DPC-001):
 *   1. Environment variable (hard override — always wins)
 *   2. In-process cache (30s TTL)
 *   3. Postgres E-OPERATIONAL-TOGGLE table (PH-02+)
 *   4. Safe default: false
 *
 * The env var override is intentional: it allows instant kill-switches
 * without a deploy, and prevents DB outages from disabling safety guards.
 */
export async function getToggle(key: string): Promise<boolean> {
  // 1. Env var hard override
  const envValue = readEnvOverride(key)
  if (envValue !== null) return envValue

  // 2. In-process cache
  const cached = _cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  // 3. DB lookup (stub — implemented in PH-02 when toggle table exists)
  const dbValue = await fetchFromDb(key)

  _cache.set(key, { value: dbValue, expiresAt: Date.now() + CACHE_TTL_MS })
  return dbValue
}

/** Clears the toggle cache — useful in tests. */
export function clearToggleCache(): void {
  _cache.clear()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readEnvOverride(key: string): boolean | null {
  // Check typed config keys first (most keys)
  const typedKey = key as keyof typeof config
  if (typedKey in config) {
    const v = config[typedKey]
    if (typeof v === 'boolean') return v
  }

  // Fallback: raw env var
  const raw = process.env[key.toUpperCase()]
  if (raw !== undefined) return raw === 'true'

  return null
}

async function fetchFromDb(key: string): Promise<boolean> {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('operational_toggles')
    .select('enabled')
    .eq('key', key)
    .maybeSingle()

  if (error || !data) return false
  return data.enabled
}
