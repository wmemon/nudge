// Public API for abandonment-lifecycle module.
// Called by the MAINTENANCE worker job handler in src/worker/worker-registry.ts.
export { enforceOutboundStop, enqueuePreGoalPurges } from './application/index.js'
