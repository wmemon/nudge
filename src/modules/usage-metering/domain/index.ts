// E-USAGE-COUNTER domain — types and pure threshold logic.
// No I/O here; all database calls live in data-access.
// Scope: soft-warning only in MVP (Q1.R1). Hard enforcement flip is product-owned
// and remains off until numeric caps are defined (resolved-architecture-intake §16-17).

// ── Types ─────────────────────────────────────────────────────────────────────

/** The two metric dimensions tracked in MVP. Closed set — adding a third requires a migration. */
export type MetricType = 'goals_set' | 'checkins_completed'

/** Maps to one row in the usage_counters table (E-USAGE-COUNTER). */
export interface UsageCounter {
  id:          string
  recipientId: string
  metricType:  MetricType
  count:       number
  updatedAt:   Date
}

// ── Pure domain logic ─────────────────────────────────────────────────────────

/**
 * Returns true when count has reached or exceeded the configured soft-warning
 * threshold. Pure function — no side effects.
 *
 * With default threshold of 9999, this is always false in MVP.
 * Set USAGE_GOAL_WARN_THRESHOLD / USAGE_CHECKIN_WARN_THRESHOLD to a low value
 * to activate warnings (resolved-architecture-intake §17).
 */
export function evaluateThreshold(count: number, threshold: number): boolean {
  return count >= threshold
}
