import pino from 'pino'
import { config } from '../config/index.js'

// Fields that must never appear in logs or be forwarded to Sentry (OAC-002)
const REDACT_PATHS = [
  '*.body',
  '*.otp',
  '*.token',
  '*.presignedUrl',
  '*.rawBody',
  '*.messageBody',
  '*.apiKey',
  '*.webhookSecret',
  'body',
  'otp',
  'token',
  'presignedUrl',
  'rawBody',
  'messageBody',
  'apiKey',
  'webhookSecret',
]

const baseLogger = pino({
  level: config.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  ...(config.NODE_ENV === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  }),
})

/**
 * Returns a child logger with optional bound context fields.
 * Use this for per-module or per-request loggers.
 *
 * @example
 *   const log = createLogger({ module: 'webhook-ingestion' })
 *   log.info({ event: 'webhook.received' })
 */
export function createLogger(context?: Record<string, unknown>): pino.Logger {
  return context ? baseLogger.child(context) : baseLogger
}

export type Logger = pino.Logger
