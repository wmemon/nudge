// E-PROACTIVE-POLICY-STATE (data-model-and-ownership §4)
// Per-recipient state for ADR §13 proactive sending policy.
// Owned exclusively by the proactive-policy module.

export interface ProactivePolicyState {
  id:                      string
  recipientId:             string

  // Spacing enforcement
  lastProactiveSentAt:     Date | null
  effectiveSpacingMinutes: number

  // Rolling 24h cap
  rolling24hCount:         number
  rolling24hWindowStart:   Date

  // 7-day reply-rate window
  proactiveCount7d:        number
  inboundReplies7d:        number
  window7dStartedAt:       Date

  createdAt:               Date
  updatedAt:               Date
}
