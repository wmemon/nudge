// Public API for usage-metering module.
// Called fire-and-forget from goal-scheduling after goal capture and check-in send.
export type { IncrementResult } from './application/index.js'
export { incrementGoalCount, incrementCheckinCount } from './application/index.js'
