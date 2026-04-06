import { z } from 'zod'

// ── Schema ────────────────────────────────────────────────────────────────────
//
// Required at startup (cause fail-fast if missing):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — needed for /ready check
//
// Optional / defaulted (external APIs not called in scaffolding phase):
//   AWS, LoopMessage, OpenAI, Anthropic, Turnstile
//   These become effectively required once the corresponding platform module
//   is invoked; callers should validate before use.
//
// DPC-001: env vars always win over DB-level operational toggles (ADR §8).

const booleanString = z
  .string()
  .transform((v) => v === 'true')

const envSchema = z.object({
  // App
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  // Supabase — required: used in /ready health check at boot
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Redis — required: used in /ready health check at boot
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // AWS S3 — optional until S3 platform is first called (PH-04+)
  AWS_ACCESS_KEY_ID: z.string().default(''),
  AWS_SECRET_ACCESS_KEY: z.string().default(''),
  AWS_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default(''),
  S3_PREFIX_EXPORTS: z.string().default('exports/'),
  S3_PREFIX_BACKUPS: z.string().default('backups/'),
  S3_PRESIGN_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  S3_ENDPOINT_URL: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: booleanString.default('false'),

  // LoopMessage — optional until webhook integration is live (PH-02+)
  LOOPMESSAGE_API_KEY: z.string().default(''),
  // Static shared-secret sent by LoopMessage in every inbound webhook request.
  // Set LOOPMESSAGE_WEBHOOK_AUTH_HEADER to match the header name configured in
  // the LoopMessage dashboard (Webhooks → Authorization Header).
  LOOPMESSAGE_WEBHOOK_SECRET: z.string().default(''),
  LOOPMESSAGE_WEBHOOK_AUTH_HEADER: z.string().default('x-loopmessage-secret'),
  LOOPMESSAGE_ALLOWLIST: z.string().default(''),

  // LLM (OpenRouter) — optional until LLM router is wired (PH-03+)
  // OpenRouter uses the OpenAI SDK with a custom baseURL — no @anthropic-ai/sdk needed.
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_PRIMARY_MODEL: z.string().default('anthropic/claude-sonnet-4-6'),
  OPENROUTER_FALLBACK_MODEL: z.string().default('openai/gpt-4o'),

  // Cloudflare Turnstile — optional until OTP endpoints are live (PH-06+)
  TURNSTILE_SECRET_KEY: z.string().default(''),

  // CORS
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3001'),

  // Sentry — empty string = disabled (safe for local dev)
  SENTRY_DSN: z.string().default(''),
  SENTRY_ENVIRONMENT: z.string().default('development'),

  // Freemium soft-warning thresholds (Q1.R1) — set low to enable in-iMessage warnings.
  // Defaults to 9999 (effectively never warn) until product defines numeric caps
  // (resolved-architecture-intake §16-17). Hard enforcement flip remains product-owned.
  USAGE_GOAL_WARN_THRESHOLD:    z.coerce.number().int().positive().default(9999),
  USAGE_CHECKIN_WARN_THRESHOLD: z.coerce.number().int().positive().default(9999),

  // Operational toggles — env vars are the hard override (DPC-001, ADR §8)
  PROACTIVE_SENDS_ENABLED: booleanString.default('true'),
  PROACTIVE_CAP_PER_24H: z.coerce.number().int().nonnegative().default(8),
  PROACTIVE_MIN_SPACING_MINUTES: z.coerce.number().int().nonnegative().default(90),
  LLM_CALLS_ENABLED: booleanString.default('true'),
  RIGHTS_ENDPOINTS_ENABLED: booleanString.default('true'),
  // Startup invariant only — not a runtime toggle.
  // Setting this to anything other than "true" in non-production causes boot to fail (DPC-004).
  // Runtime enforcement uses NODE_ENV; this var exists to prevent accidental config drift.
  ENFORCE_OUTBOUND_ALLOWLIST: z.string().default('true'),
})

// ── Loader ────────────────────────────────────────────────────────────────────

function loadConfig() {
  const result = envSchema.safeParse(process.env)

  if (!result.success) {
    const missing = result.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n')
    throw new Error(
      `Config validation failed — missing or invalid environment variables:\n${missing}`,
    )
  }

  const cfg = result.data

  // SPC-002 / DPC-004: outbound allowlist must be enforced in non-production.
  // Throw at boot to prevent accidental real sends in dev/staging.
  if (cfg.NODE_ENV !== 'production' && cfg.NODE_ENV !== 'test' && cfg.ENFORCE_OUTBOUND_ALLOWLIST !== 'true') {
    throw new Error(
      'ENFORCE_OUTBOUND_ALLOWLIST must be "true" in non-production environments (SPC-002, DPC-004)',
    )
  }

  // AIC-001: webhook signature verification is impossible without a secret.
  // Fail fast in production so a missing secret causes a deploy failure rather
  // than silently dropping every inbound webhook with 401.
  if (cfg.NODE_ENV === 'production' && !cfg.LOOPMESSAGE_WEBHOOK_SECRET) {
    throw new Error(
      'LOOPMESSAGE_WEBHOOK_SECRET must be set in production (AIC-001)',
    )
  }

  // Fail fast if outbound or LLM keys are missing in production.
  // Without these, the inbound turn would fail mid-job after the message is
  // already received — better to crash at boot.
  if (cfg.NODE_ENV === 'production' && !cfg.LOOPMESSAGE_API_KEY) {
    throw new Error('LOOPMESSAGE_API_KEY must be set in production')
  }

  if (cfg.NODE_ENV === 'production' && !cfg.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY must be set in production')
  }

  // Fail fast if Turnstile secret is missing in production.
  // Without it, every OTP request fails at the Cloudflare verify step —
  // the entire user-rights flow (export + delete) is silently broken.
  if (cfg.NODE_ENV === 'production' && !cfg.TURNSTILE_SECRET_KEY) {
    throw new Error('TURNSTILE_SECRET_KEY must be set in production')
  }

  // Fail fast if S3 credentials or bucket are missing in production.
  // Export and delete are the highest-trust user-rights flows — a missing
  // S3 credential should surface at boot, not silently inside a BullMQ job
  // after a user has already triggered an export or account deletion.
  if (cfg.NODE_ENV === 'production' && !cfg.AWS_ACCESS_KEY_ID) {
    throw new Error('AWS_ACCESS_KEY_ID must be set in production')
  }
  if (cfg.NODE_ENV === 'production' && !cfg.AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS_SECRET_ACCESS_KEY must be set in production')
  }
  if (cfg.NODE_ENV === 'production' && !cfg.S3_BUCKET) {
    throw new Error('S3_BUCKET must be set in production')
  }

  // Fail fast if CORS origins are still the localhost default in production.
  // A misconfigured CORS allowlist silently blocks the Vercel frontend —
  // set CORS_ALLOWED_ORIGINS to the production + staging Vercel origin(s).
  if (cfg.NODE_ENV === 'production' && cfg.CORS_ALLOWED_ORIGINS === 'http://localhost:3001') {
    throw new Error(
      'CORS_ALLOWED_ORIGINS must be set to the Vercel production origin(s) in production — do not use the localhost default',
    )
  }

  return Object.freeze(cfg)
}

// ── Exports ───────────────────────────────────────────────────────────────────

export const config = loadConfig()
export type Config = typeof config

/** Parsed CORS origins as an array */
export function getCorsOrigins(): string[] {
  return config.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
}
