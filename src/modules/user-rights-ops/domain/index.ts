// user-rights-ops domain
//
// Entities owned by this module:
//   E-EXPORT-JOB      — state machine + SLA tracking (data-model-and-ownership §4)
//   E-EXPORT-ARTIFACT — S3 bundle metadata (data-model-and-ownership §4)
//   E-DELETE-JOB      — deletion orchestration (data-model-and-ownership §4; Slice 8)
//
// Pure business rules only — no platform imports, no vendor SDKs (MBC-002).

// ── Export job state machine ──────────────────────────────────────────────────

export const EXPORT_STATUS = {
  QUEUED:    'queued',
  BUILDING:  'building',
  DELIVERED: 'delivered',
  FAILED:    'failed',
} as const

export type ExportStatus = typeof EXPORT_STATUS[keyof typeof EXPORT_STATUS]

/**
 * Legal state transitions for an export job.
 * Any attempt to move outside these pairs is a logic error.
 */
const ALLOWED_TRANSITIONS: ReadonlyMap<ExportStatus, readonly ExportStatus[]> = new Map([
  [EXPORT_STATUS.QUEUED,    [EXPORT_STATUS.BUILDING, EXPORT_STATUS.FAILED]],
  [EXPORT_STATUS.BUILDING,  [EXPORT_STATUS.DELIVERED, EXPORT_STATUS.FAILED]],
  [EXPORT_STATUS.DELIVERED, []],  // terminal
  [EXPORT_STATUS.FAILED,    []],  // terminal
])

/**
 * Asserts that transitioning from `from` to `to` is legal.
 * Throws if the transition is not in the allowed set — call this before
 * every status UPDATE so the application layer never writes illegal state.
 */
export function assertExportTransition(from: ExportStatus, to: ExportStatus): void {
  const allowed = ALLOWED_TRANSITIONS.get(from) ?? []
  if (!(allowed as readonly string[]).includes(to)) {
    throw new Error(
      `Invalid export job transition: ${from} → ${to}. ` +
      `Allowed from ${from}: [${allowed.join(', ') || 'none — terminal state'}]`,
    )
  }
}

// ── SLA deadline ──────────────────────────────────────────────────────────────

const ET_TZ = 'America/New_York'

/**
 * Returns the SLA deadline for an export request: 23:59:59 ET on the third
 * US business day (Mon–Fri), counting inclusively from the request date in ET.
 *
 * Rules (ADR §14):
 *  - If the request falls on a business day, that day counts as day 1.
 *  - If the request falls on a weekend, the following Monday is day 1.
 *  - Federal holidays are NOT excluded in v1.
 *    // TODO: add US federal holiday exclusion post-MVP
 */
export function computeExportSlaDeadline(requestedAt: Date): Date {
  let current   = new Date(requestedAt)
  let bizDays   = 0

  // Count the request date itself if it is a business day in ET.
  if (_isEtBusinessDay(current)) {
    bizDays = 1
  }

  // Advance one calendar day at a time until we reach the third business day.
  while (bizDays < 3) {
    current = new Date(current.getTime() + 86_400_000)
    if (_isEtBusinessDay(current)) {
      bizDays++
    }
  }

  // `current` is now somewhere within the third business day (UTC).
  // Compute "23:59:59 America/New_York on that calendar date" as a UTC Date.
  return _eodInNewYork(current)
}

/** True if `date` falls on Monday–Friday in the ET timezone. */
function _isEtBusinessDay(date: Date): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ,
    weekday: 'short',
  }).format(date)
  return weekday !== 'Sat' && weekday !== 'Sun'
}

/**
 * Returns the UTC instant corresponding to 23:59:59 ET on the same calendar
 * date as `date` (in ET).
 *
 * Strategy: probe the ET offset at noon UTC on the target date (noon is safely
 * mid-day regardless of DST transitions), then back-calculate the UTC time for
 * ET 23:59:59 on that date. Date.UTC handles hour overflow into the next UTC
 * day automatically.
 */
function _eodInNewYork(date: Date): Date {
  // Get the year/month/day of `date` expressed in ET.
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ,
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
  }).formatToParts(date)

  const year  = parseInt(_part(dateParts, 'year'))
  const month = parseInt(_part(dateParts, 'month'))
  const day   = parseInt(_part(dateParts, 'day'))

  // Probe at noon UTC on that ET date to determine the current ET offset.
  // ET is always UTC-4 (EDT) or UTC-5 (EST); noon UTC is always mid-morning ET.
  const probe        = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  const probeEtHour  = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: ET_TZ,
      hour:     '2-digit',
      hour12:   false,
    }).format(probe),
  )
  // offsetHours: how many hours ET is behind UTC (4 for EDT, 5 for EST).
  const offsetHours = 12 - probeEtHour

  // ET 23:59:59 expressed as UTC: add the offset to 23:59:59 on the ET date.
  // Date.UTC handles the resulting hour > 23 by rolling into the next day.
  return new Date(Date.UTC(year, month - 1, day, 23 + offsetHours, 59, 59))
}

/** Extracts a named part from Intl.DateTimeFormat#formatToParts output. */
function _part(parts: Intl.DateTimeFormatPart[], type: string): string {
  const found = parts.find((p) => p.type === type)
  if (!found) throw new Error(`Missing Intl date part: ${type}`)
  return found.value
}

// ── S3 key generation ─────────────────────────────────────────────────────────

/**
 * Returns the S3 key for an export bundle.
 *
 * Pattern: <prefix><recipientId>/<jobId>/export.json
 *
 * The prefix is passed in by the application layer (not imported from config
 * here — domain must not import platform modules, MBC-002). Each job gets its
 * own path so re-exports produce distinct keys automatically.
 */
export function generateExportS3Key(params: {
  prefix:      string  // e.g. "exports/" — from config.S3_PREFIX_EXPORTS
  recipientId: string
  jobId:       string
}): string {
  return `${params.prefix}${params.recipientId}/${params.jobId}/export.json`
}

// ── Export bundle types (Q6.R2 scope) ────────────────────────────────────────
//
// These shapes define exactly what goes into the export bundle.
// Scope is locked by Q6.R2: message history (text + timestamps) +
// active goal config + scheduler fields (schedule + quiet-hours inputs).
// Do NOT add NLU outcomes, accountability state, internal IDs, or any
// other derived internals without a product decision to expand export scope.

export interface ExportMessage {
  direction:  'inbound' | 'outbound'
  body:       string
  sentAt:     string  // ISO 8601 UTC
}

export interface ExportGoal {
  text:       string
  createdAt:  string  // ISO 8601 UTC
}

export interface ExportSchedule {
  checkInTime:      string   // "HH:MM" in the recipient's local timezone
  timezone:         string   // IANA timezone string
  cadence:          string   // e.g. "daily"
  quietHoursStart:  number   // hour 0–23 local
  quietHoursEnd:    number   // hour 0–23 local
}

export interface ExportBundle {
  generatedAt: string         // ISO 8601 UTC — when the bundle was produced
  messages:    ExportMessage[]
  goal:        ExportGoal | null
  schedule:    ExportSchedule | null
}

// ── Delete job state machine ──────────────────────────────────────────────────

export const DELETE_STATUS = {
  PENDING:   'pending',
  EXECUTING: 'executing',
  FAILED:    'failed',
} as const

export type DeleteStatus = typeof DELETE_STATUS[keyof typeof DELETE_STATUS]

/**
 * Legal state transitions for a delete job.
 *
 * pending   → executing  (worker picks up job)
 * executing → failed     (saga step threw; BullMQ will retry)
 * failed    → executing  (BullMQ retry started)
 *
 * There is no executing → completed transition. Completion is implicit:
 * the final saga step deletes the recipient row, which cascades the
 * delete_jobs row away. Any retry after a successful deletion finds no
 * recipient and exits immediately without calling assertDeleteTransition.
 */
const DELETE_ALLOWED_TRANSITIONS: ReadonlyMap<DeleteStatus, readonly DeleteStatus[]> = new Map([
  [DELETE_STATUS.PENDING,   [DELETE_STATUS.EXECUTING]],
  [DELETE_STATUS.EXECUTING, [DELETE_STATUS.FAILED]],
  [DELETE_STATUS.FAILED,    [DELETE_STATUS.EXECUTING]],
])

export function assertDeleteTransition(from: DeleteStatus, to: DeleteStatus): void {
  const allowed = DELETE_ALLOWED_TRANSITIONS.get(from) ?? []
  if (!(allowed as readonly string[]).includes(to)) {
    throw new Error(
      `Invalid delete job transition: ${from} → ${to}. ` +
      `Allowed from ${from}: [${allowed.join(', ') || 'none'}]`,
    )
  }
}
