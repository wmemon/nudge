// Abandonment lifecycle policy constants and types.
// Rules source: clarification-answers Q3.R3, resolved-architecture-intake §4.

/** Stop automated outbound after this many days from first_seen_at with no goal (Q3.R3). */
export const ABANDONMENT_STOP_DAYS = 7

/** Purge recipient and all app data after this many days with no goal and no inbound activity (Q3.R3). */
export const PURGE_DAYS = 90

/**
 * Minimal shape returned by eligibility queries.
 * handle is included for logging context only — never logged directly (OAC-002).
 */
export interface AbandonedRecipient {
  id:          string
  firstSeenAt: Date
}
