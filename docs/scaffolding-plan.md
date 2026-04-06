# Scaffolding Plan — Nudge MVP Backend (PH-00 + PH-01)

**Status:** Approved — ready to build
**Date:** 2026-03-30
**Covers:** Project setup, folder skeleton, config, platform wiring, HTTP server, worker, observability, local dev, CI/CD
**Does not cover:** Business logic, API routes beyond health/ready, database migrations

---

## Locked Decisions

| ID  | Decision                          | Choice                  |
| --- | --------------------------------- | ----------------------- |
| D1  | Package manager                   | `pnpm`                  |
| D2  | Node.js version                   | `22 LTS`                |
| D3  | Module system                     | `ESM` (native)          |
| D4  | Test runner                       | `vitest`                |
| D5  | Commit hooks                      | `husky`                 |
| D6  | S3 included in `/ready` check     | No                      |
| D7  | Git host / CI system              | GitHub Actions          |
| D8  | Worker service type on Render     | Background Worker       |
| D9  | `identity-recipient` as module    | Yes — locked, 10th module |

---

## Step 1 — Repo & Tooling

### Files to create

```
package.json           # scripts: dev:api, dev:worker, dev, lint, typecheck, test, build
tsconfig.json          # base config — strict, NodeNext, ES2022
tsconfig.build.json    # extends base — excludes tests, outDir: dist/
.eslintrc.cjs          # @typescript-eslint/recommended + import rules
.prettierrc            # single quotes, 100 col, trailing commas
.husky/pre-commit      # runs lint-staged on staged files only
.lintstagedrc.cjs      # lint + format staged files
.gitignore             # node_modules/, dist/, .env, .env.*, *.log, coverage/
.nvmrc                 # 22
```

### TypeScript config (`tsconfig.json`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

### ESLint import boundary rules

Two rules enforced to preserve architecture constraints:

- Importing `openai` outside `src/platform/llm-router/` → error (MBC-002; `openai` npm package used as the OpenRouter client via custom `baseURL` — `@anthropic-ai/sdk` is not used)
- Importing `@supabase/supabase-js` outside `src/platform/db-supabase/` → error (MBC-003)

### package.json scripts

```json
{
  "scripts": {
    "dev:api":    "tsx watch src/app/http-server.ts",
    "dev:worker": "tsx watch src/worker/worker-runner.ts",
    "dev":        "concurrently \"pnpm dev:api\" \"pnpm dev:worker\"",
    "lint":       "eslint src/ tests/",
    "typecheck":  "tsc --noEmit",
    "test":       "vitest run",
    "test:watch": "vitest",
    "build":      "tsc -p tsconfig.build.json"
  }
}
```

### Key dev dependencies

```
tsx               # run TypeScript directly (dev only)
concurrently      # run api + worker together in dev
vitest            # test runner
@types/node
typescript
eslint + plugins
prettier
husky
lint-staged
```

---

## Step 2 — Folder Structure Skeleton

Every folder gets a placeholder `index.ts` so the import graph compiles from day one.
No business logic — structure only.

```
/
├── src/
│   │
│   ├── app/
│   │   ├── middleware/
│   │   │   └── index.ts             # placeholder
│   │   ├── routes/
│   │   │   └── index.ts             # placeholder
│   │   └── index.ts                 # exports createApp()
│   │
│   ├── modules/
│   │   │
│   │   ├── identity-recipient/      # LOCKED — sole owner of E-RECIPIENT
│   │   │   ├── domain/
│   │   │   │   └── index.ts
│   │   │   ├── adapters/
│   │   │   │   └── index.ts
│   │   │   ├── data-access/
│   │   │   │   └── index.ts
│   │   │   ├── application/
│   │   │   │   └── index.ts
│   │   │   └── index.ts             # public API — other modules import from here only
│   │   │
│   │   ├── webhook-ingestion/
│   │   │   ├── domain/
│   │   │   │   └── index.ts
│   │   │   ├── adapters/
│   │   │   │   └── index.ts
│   │   │   ├── data-access/
│   │   │   │   └── index.ts
│   │   │   ├── application/
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── conversation-accountability/
│   │   │   ├── domain/
│   │   │   │   └── index.ts
│   │   │   ├── adapters/
│   │   │   │   └── index.ts
│   │   │   ├── data-access/
│   │   │   │   └── index.ts
│   │   │   ├── application/
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── goal-scheduling/
│   │   │   ├── domain/
│   │   │   │   └── index.ts
│   │   │   ├── adapters/
│   │   │   │   └── index.ts
│   │   │   ├── data-access/
│   │   │   │   └── index.ts
│   │   │   ├── application/
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── outbound-messaging/
│   │   │   ├── domain/
│   │   │   │   └── index.ts
│   │   │   ├── adapters/
│   │   │   │   └── index.ts
│   │   │   ├── data-access/
│   │   │   │   └── index.ts
│   │   │   ├── application/
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── otp-verification/
│   │   │   ├── domain/
│   │   │   │   └── index.ts
│   │   │   ├── adapters/
│   │   │   │   └── index.ts
│   │   │   ├── data-access/
│   │   │   │   └── index.ts
│   │   │   ├── application/
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── user-rights-ops/
│   │   │   ├── domain/
│   │   │   │   └── index.ts
│   │   │   ├── adapters/
│   │   │   │   └── index.ts
│   │   │   ├── data-access/
│   │   │   │   └── index.ts
│   │   │   ├── application/
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── proactive-policy/
│   │   │   ├── domain/
│   │   │   │   └── index.ts
│   │   │   ├── adapters/
│   │   │   │   └── index.ts
│   │   │   ├── data-access/              # needed — E-PROACTIVE-POLICY-STATE is Postgres
│   │   │   │   └── index.ts
│   │   │   ├── application/
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── abandonment-lifecycle/
│   │   │   ├── domain/
│   │   │   │   └── index.ts
│   │   │   ├── adapters/
│   │   │   │   └── index.ts
│   │   │   ├── data-access/
│   │   │   │   └── index.ts
│   │   │   ├── application/
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   │
│   │   └── usage-metering/              # LOCKED name
│   │       ├── domain/
│   │       │   └── index.ts
│   │       ├── adapters/
│   │       │   └── index.ts
│   │       ├── data-access/
│   │       │   └── index.ts
│   │       ├── application/
│   │       │   └── index.ts
│   │       └── index.ts
│   │
│   ├── platform/
│   │   ├── config/
│   │   │   └── index.ts               # env loader + startup validation (fail fast)
│   │   ├── db-supabase/
│   │   │   └── index.ts               # getSupabaseClient(), checkDb()
│   │   ├── queue-bullmq/
│   │   │   ├── queues.ts              # queue name registry + Queue instances
│   │   │   ├── redis-connection.ts    # createRedisConnection(), checkRedis()
│   │   │   └── index.ts
│   │   ├── storage-s3/
│   │   │   └── index.ts               # createS3Client(), checkStorage()
│   │   ├── loopmessage-adapter/
│   │   │   └── index.ts               # verifySignature() stub, sendMessage() stub
│   │   ├── llm-router/
│   │   │   ├── openrouter-adapter.ts  # only file allowed to import 'openai' (used as OpenRouter client)
│   │   │   └── index.ts               # router types + createLLMRouter() stub
│   │   ├── turnstile-verify/
│   │   │   └── index.ts               # verifyCaptcha() stub
│   │   ├── toggles/
│   │   │   └── index.ts               # getToggle(key) — reads Postgres E-OPERATIONAL-TOGGLE
│   │   │                              # short in-process cache; env var wins (ADR §8)
│   │   └── observability/
│   │       ├── logger.ts              # Pino instance factory
│   │       ├── sentry.ts              # Sentry init (no-op if SENTRY_DSN is empty)
│   │       └── index.ts
│   │
│   ├── shared/
│   │   ├── errors/
│   │   │   └── index.ts               # AppError base class + typed error envelopes
│   │   ├── correlation/
│   │   │   └── index.ts               # generateRequestId(), extractFromHeader()
│   │   ├── validation/
│   │   │   └── index.ts               # Zod re-export + parse helpers
│   │   └── index.ts
│   │
│   ├── worker/
│   │   ├── worker-runner.ts           # entrypoint: boot, graceful shutdown
│   │   └── worker-registry.ts         # registers all BullMQ consumers; imports handlers from modules
│   │
│   └── scripts/
│       └── .gitkeep                   # operational scripts live here (non-runtime)
│
├── tests/
│   ├── slices/                        # per-module boundary tests
│   ├── integration/                   # webhook trust, retry, DLQ, deletion side-effects
│   ├── platform/                      # config validation, readiness, S3 prefix tests
│   └── fixtures/                      # shared test builders and neutral data helpers
│
├── supabase/
│   └── migrations/                    # empty now; populated from PH-02 onward
│
├── docs/
│   └── runbooks/                      # DLQ handling, recovery, incident procedures
│       └── .gitkeep
│
└── docker-compose.yml
```

---

## Step 3 — Environment & Config

### `.env.example`

```bash
# ── App ──────────────────────────────────────────────────────────────
NODE_ENV=development                    # development | staging | production
PORT=3000
LOG_LEVEL=debug                         # trace | debug | info | warn | error

# ── Supabase (Postgres) ───────────────────────────────────────────────
SUPABASE_URL=                           # https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=              # server-only; never expose to browser

# ── Redis ─────────────────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379

# ── AWS S3 ────────────────────────────────────────────────────────────
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1
S3_BUCKET=                              # one bucket per environment
S3_PREFIX_EXPORTS=exports/             # user export artifacts
S3_PREFIX_BACKUPS=backups/             # CI-produced database backup artifacts
S3_PRESIGN_TTL_SECONDS=86400           # 24h default (Q4.R6)
# Local dev only (MinIO):
S3_ENDPOINT_URL=http://localhost:9000
S3_FORCE_PATH_STYLE=true

# ── LoopMessage ───────────────────────────────────────────────────────
LOOPMESSAGE_API_KEY=
LOOPMESSAGE_WEBHOOK_SECRET=            # for HMAC signature verification
LOOPMESSAGE_ALLOWLIST=                 # comma-separated; REQUIRED in non-prod (DPC-004)

# ── LLM ──────────────────────────────────────────────────────────────
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=                       # set to current Anthropic model at integration time

# ── Cloudflare Turnstile ──────────────────────────────────────────────
TURNSTILE_SECRET_KEY=

# ── CORS ─────────────────────────────────────────────────────────────
CORS_ALLOWED_ORIGINS=http://localhost:3001  # comma-separated Vercel + local origins

# ── Sentry ───────────────────────────────────────────────────────────
SENTRY_DSN=                            # empty = disabled (safe for local dev)
SENTRY_ENVIRONMENT=development

# ── Operational toggles (DPC-001: env hard-override wins over DB flags) ──
PROACTIVE_SENDS_ENABLED=true
PROACTIVE_CAP_PER_24H=8                # ADR §13 default
PROACTIVE_MIN_SPACING_MINUTES=90       # ADR §13 default
LLM_CALLS_ENABLED=true
RIGHTS_ENDPOINTS_ENABLED=true
ENFORCE_OUTBOUND_ALLOWLIST=true        # MUST be true in non-prod (DPC-004)
```

### Config loader behaviour (`src/platform/config/index.ts`)

1. Parse all env vars with Zod — typed, not scattered `process.env.X` calls
2. **Fail fast on boot** — if any required var is missing, throw with the full list of missing vars; never start with silent defaults for required values (DPC-001)
3. Startup safety check — if `NODE_ENV !== 'production'` and `ENFORCE_OUTBOUND_ALLOWLIST !== 'true'`, throw at boot (SPC-002, DPC-004)
4. Export a single frozen `config` object — nothing else reads `process.env` directly

---

## Step 4 — Platform Wiring

### Supabase (`src/platform/db-supabase/`)

```typescript
export function getSupabaseClient(): SupabaseClient
// service-role key, server-only, never exposed to browser (MBC-003)

export async function checkDb(): Promise<{ ok: boolean; latencyMs: number }>
// runs SELECT 1 — used by /ready endpoint
// no explicit close needed — supabase-js is HTTP-based
```

### Redis + BullMQ (`src/platform/queue-bullmq/`)

Queue names (one `MAINTENANCE` queue; job type discriminated by payload field):

```typescript
export const QUEUE_NAMES = {
  INBOUND_CONTINUATION: 'inbound-continuation',
  SCHEDULED_CHECKIN:    'scheduled-checkin',
  EXPORT_FULFILLMENT:   'export-fulfillment',
  DELETE_FULFILLMENT:   'delete-fulfillment',
  MAINTENANCE:          'maintenance',   // covers: 7-day-stop, 90-day-purge, housekeeping
} as const
```

Exports:

```typescript
export function createRedisConnection(): Redis
export async function checkRedis(): Promise<{ ok: boolean; latencyMs: number }>
// runs PING — used by /ready endpoint
export function getQueue(name: QueueName): Queue       // singleton per queue
export async function closeQueues(): Promise<void>     // graceful shutdown
```

**Graceful shutdown:** `closeQueues()` closes all Queue connections. Worker consumers call `.close()` + bounded 30s wait for in-flight jobs before `process.exit(0)`.

**Fail closed rule:** routes that use Redis-backed rate limits must return an error if Redis is unavailable — never silently skip the limit check (ADR §9).

### S3 (`src/platform/storage-s3/`)

```typescript
export function createS3Client(): S3Client
// uses S3_ENDPOINT_URL if set → MinIO for local dev; real AWS for staging/prod

export async function checkStorage(): Promise<{ ok: boolean }>
// lightweight HeadBucket check — NOT included in /ready (D6); available for ops use
```

### LoopMessage adapter (`src/platform/loopmessage-adapter/`)

Stubs only — implementation filled in during PH-02/PH-03 against vendor docs (AIC-004):

```typescript
export async function verifyWebhookSignature(
  rawBody: Buffer,
  headers: IncomingHeaders
): Promise<boolean>

export async function sendMessage(
  to: string,
  body: string,
  idempotencyKey: string
): Promise<void>
```

### LLM Router (`src/platform/llm-router/`)

```typescript
// openrouter-adapter.ts — the ONLY file that may import 'openai'
// Uses OpenAI SDK with baseURL: 'https://openrouter.ai/api/v1' + OPENROUTER_API_KEY
// Model fallback via OpenRouter's `models` array (no @anthropic-ai/sdk needed)

export interface LLMRouter {
  complete(request: LLMRequest): Promise<LLMResponse>
}
export function createLLMRouter(): LLMRouter   // stub for now; wired in PH-03
```

### Operational Toggles (`src/platform/toggles/`)

```typescript
export async function getToggle(key: string): Promise<boolean>
// reads E-OPERATIONAL-TOGGLE from Postgres
// short in-process TTL cache for performance
// env var always wins over DB value (ADR §8, DPC-001)
```

### Observability (`src/platform/observability/`)

```typescript
// logger.ts
export function createLogger(context?: Record<string, unknown>): Logger
// Pino JSON output; level from LOG_LEVEL config
// redactPaths: ['*.body', '*.otp', '*.token', '*.presignedUrl',
//               '*.rawBody', '*.messageBody', '*.apiKey']  (OAC-002)

// sentry.ts
export function initSentry(): void
// no-op if SENTRY_DSN is empty — safe for local dev
// beforeSend strips request body + sensitive breadcrumbs
```

---

## Step 5 — HTTP Server Bootstrap

### Middleware stack (in order)

1. **Raw body preservation** — `contentTypeParser` for webhook route; keeps `Buffer` available for signature verification before JSON parsing (ADR §3, §5)
2. **Correlation ID** — read `x-request-id` header → generate UUID v4 if absent → attach to request + logger (OAC-001)
3. **Request logger** — Pino HTTP serializer; logs method, path, status, latency; **no body content** (OAC-002)
4. **CORS** — `@fastify/cors` with `CORS_ALLOWED_ORIGINS` allowlist (ADR §9)
5. **Global error handler** — maps `AppError` subtypes to HTTP status; always returns the standard error envelope

### Error envelope (contracts-first §8)

Every error response, every route:

```json
{
  "error": {
    "code": "<machine-readable string>",
    "message": "<safe, non-enumerating>"
  },
  "requestId": "<x-request-id value>",
  "details": []
}
```

`details[]` is optional — field-level validation errors only; never sensitive data.

### Routes mounted at scaffolding time

| Method | Path | Handler |
| ------ | ---- | ------- |
| GET | `/health` | Liveness — always 200 while process runs (API-HLTH-001) |
| GET | `/ready` | Readiness — checks Postgres + Redis (API-HLTH-002) |

Future routes mounted in later phases:

| Method | Path | Phase |
| ------ | ---- | ----- |
| POST | `/webhooks/loopmessage` | PH-02 |
| POST | `/utility/otp/request` | PH-06 |
| POST | `/utility/otp/verify` | PH-06 |
| POST | `/utility/rights/export` | PH-06 |
| POST | `/utility/rights/delete` | PH-06 |

### `/health` response

```json
{ "status": "ok" }
```

### `/ready` response

200 when both pass; 503 when either fails:

```json
{
  "status": "ok",
  "checks": {
    "db":    { "ok": true, "latencyMs": 12 },
    "redis": { "ok": true, "latencyMs": 3  }
  }
}
```

### Entrypoint boot order (`src/app/http-server.ts`)

1. Load + validate config → fail fast if anything missing
2. Init Sentry
3. Create Supabase client
4. Create Redis connection
5. Create Fastify app with all middleware
6. Mount health + ready routes
7. Listen on `PORT`
8. Register `SIGTERM` handler → `fastify.close()` → `process.exit(0)`

---

## Step 6 — Worker Bootstrap

Deployed as Render **Background Worker** — no HTTP port (D8).

### Entrypoint boot order (`src/worker/worker-runner.ts`)

1. Load + validate config → fail fast if anything missing
2. Init Sentry
3. Create Redis connection
4. Register all queue consumers (empty handlers at this stage):
   - `inbound-continuation` consumer
   - `scheduled-checkin` consumer
   - `export-fulfillment` consumer
   - `delete-fulfillment` consumer
   - `maintenance` consumer (handles 7-day-stop, 90-day-purge, housekeeping by job type field)
5. Log `{ event: 'worker.ready', consumers: [...] }`

### Graceful shutdown on SIGTERM

```
1. Log "SIGTERM received, draining..."
2. Stop all consumers from accepting new jobs
3. Wait up to 30 seconds for in-flight jobs to finish
4. closeQueues()
5. process.exit(0)
```

Each consumer stub logs `{ jobId, queue, jobType }` — never logs job data content (OAC-002) — then completes immediately.

---

## Step 7 — Structured Logging

### Request log shape

```json
{
  "level": "info",
  "time": 1234567890,
  "requestId": "uuid-v4",
  "method": "POST",
  "path": "/webhooks/loopmessage",
  "statusCode": 200,
  "durationMs": 45
}
```

### Job log shape

```json
{
  "level": "info",
  "time": 1234567890,
  "requestId": "propagated-from-job-data",
  "jobId": "bullmq-job-id",
  "queue": "inbound-continuation",
  "event": "job.started"
}
```

### Redacted fields (never in logs or Sentry)

`body`, `otp`, `token`, `presignedUrl`, `rawBody`, `messageBody`, `apiKey`, `webhookSecret`

---

## Step 8 — Local Dev Setup

### `docker-compose.yml`

```yaml
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    volumes: [redis-data:/data]
    command: redis-server --save 60 1

  minio:
    image: minio/minio
    ports: ["9000:9000", "9001:9001"]   # 9001 = MinIO web console
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"
    volumes: [minio-data:/data]

volumes:
  redis-data:
  minio-data:
```

### Webhook tunnel (manual step)

LoopMessage needs a public URL to deliver webhooks in local dev.
Run: `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`
Paste the public URL into the LoopMessage dashboard.
No config file needed — document in `docs/runbooks/local-dev-setup.md` when created.

### Start order for local dev

```bash
docker compose up -d        # start Redis + MinIO
cp .env.example .env        # fill in values
pnpm dev                    # starts API + worker together via concurrently
```

---

## Step 9 — CI/CD Skeleton

### `.github/workflows/ci.yml`

```yaml
name: CI
on: [push, pull_request]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

**Note:** A migration step (`supabase db push` or equivalent) will be added to CI when the first migration is created in PH-02. Migrations run staging before production (DPC-002).

### Secrets required in CI (categories only — no values committed)

```
# Needed for integration tests against real infrastructure:
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY      # staging project only — never production
REDIS_URL                      # ephemeral Redis via GitHub Actions service container
AWS_ACCESS_KEY_ID              # staging bucket, least-privilege
AWS_SECRET_ACCESS_KEY

# Error tracking:
SENTRY_DSN                     # staging Sentry project

# Never in CI:
# Any *_PRODUCTION credentials
# LOOPMESSAGE_API_KEY (real sends)
```

---

## Dependency Rules Reminder

From `backend-folder-structure-design.md` §6 — enforced by ESLint and review:

| Direction | Allowed |
| --------- | ------- |
| `app` → | `modules`, `platform`, `shared` |
| `worker` → | `modules`, `platform`, `shared` |
| `modules/*/adapters` → | `modules/*/application` → `modules/*/domain` |
| `modules/*` → `platform` | through declared ports/interfaces only |
| `modules/*` → `shared` | neutral helpers only |

**Forbidden:**
- `domain` importing vendor SDKs, platform adapters, or `data-access`
- Module A reaching into Module B's `data-access` directly
- Any file outside `src/platform/llm-router/` importing `openai` (`@anthropic-ai/sdk` is not used)
- Any file outside `src/platform/db-supabase/` importing `@supabase/supabase-js`

---

## Source Documents (precedence order)

1. `docs/adr-001-backend-mvp-architecture.md`
2. `docs/implementation-constraints.md`
3. `docs/backend-folder-structure-design.md`
4. `docs/contracts-first-mvp-backend.md`
5. `docs/data-model-and-ownership-mvp-backend.md`
6. `docs/PRD.md`
7. `docs/clarification-answers.md`
8. `docs/resolved-architecture-intake.md`
