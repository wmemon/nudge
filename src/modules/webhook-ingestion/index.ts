// Public API for the webhook-ingestion module.
// Route handlers and other modules import from here — never from internal sub-folders.

export { normalizeLoopMessagePayload } from './adapters/index.js'
export type { NormalizedInboundEvent } from './adapters/index.js'

export { ingestWebhookEvent, markWebhookEventProcessed } from './application/index.js'
export type { IngestResult, InboundContinuationJobPayload } from './application/index.js'

export { handleInboundContinuation } from './adapters/job-handler.js'
