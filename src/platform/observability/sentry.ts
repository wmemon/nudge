import * as Sentry from '@sentry/node'
import { config } from '../config/index.js'

/**
 * Initialise Sentry error tracking.
 * No-op when SENTRY_DSN is empty — safe for local dev.
 *
 * beforeSend strips request bodies and sensitive breadcrumbs (OAC-002).
 */
export function initSentry(): void {
  if (!config.SENTRY_DSN) {
    return
  }

  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT,
    beforeSend(event) {
      // Strip request body to avoid leaking PII/secrets
      if (event.request) {
        delete event.request.data
        delete event.request.cookies
      }
      // Remove breadcrumbs that may contain sensitive content
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.filter(
          (b: { category?: string }) => b.category !== 'http' && b.category !== 'fetch',
        )
      }
      return event
    },
  })
}
