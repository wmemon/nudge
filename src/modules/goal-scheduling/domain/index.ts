// E-GOAL — active goal record for a recipient (data-model-and-ownership §4)
// E-SCHEDULE — schedule inputs + derived next-run (data-model-and-ownership §4)
// E-MISSED-WINDOW — append-only record of missed check-in windows (data-model-and-ownership §4)
// All owned by the goal-scheduling module.

export interface Goal {
  id:             string
  recipientId:    string
  text:           string
  active:         boolean
  deactivatedAt:  Date | null
  createdAt:      Date
  updatedAt:      Date
}

export interface Schedule {
  id:               string
  recipientId:      string
  goalId:           string
  /** Preferred check-in time as "HH:MM" in the recipient's local timezone */
  checkInTime:      string
  /** IANA timezone string; defaults to "UTC" until collected during onboarding (Q3.R1) */
  timezone:         string
  cadence:          'daily'
  /** Hour 0–23 (local) when quiet period begins; start > end means spans midnight */
  quietHoursStart:  number
  /** Hour 0–23 (local) when quiet period ends */
  quietHoursEnd:    number
  paused:           boolean
  snoozeUntil:      Date | null
  /** Derived next check-in instant (UTC); null before first computation (ADR §4) */
  nextRunAt:        Date | null
  createdAt:        Date
  updatedAt:        Date
}

export interface MissedWindow {
  id:           string
  recipientId:  string
  scheduledAt:  Date
  missedAt:     Date
  reason:       'downtime' | 'paused' | 'quiet_hours'
  createdAt:    Date
}
