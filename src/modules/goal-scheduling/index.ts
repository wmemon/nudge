// Public API for goal-scheduling module
export type { GoalCaptureInputs, ScheduledCheckinJobPayload } from './application/index.js'
export { captureGoal, getActiveGoal, getScheduleForRecipient, scheduleNextCheckin, recordMissedWindow } from './application/index.js'
export { handleScheduledCheckinJob } from './adapters/job-handler.js'
