# ADR 001: Backend MVP Architecture (Modular Monolith)

**Status:** Accepted  
**Date:** 2026-03-22  
**Last revised:** 2026-03-22 — §5/§14: LoopMessage webhook specifics = **integration per vendor docs** (no workshop lock); MVP skips OTP **per-IP** limits; see §9.  
**Deciders:** Product + engineering (architecture workshop, March 2026)

---

## Context

This ADR records **backend** architecture decisions for the **AI Accountability Companion** (iMessage via LoopMessage), aligned with:

- [clarification-answers.md](./clarification-answers.md) (rounds 3–4)
- [resolved-architecture-intake.md](./resolved-architecture-intake.md)

**Fixed stack (MVP, non-negotiable unless explicitly overridden):**


| Area           | Choice                                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth           | **No Clerk**; no third-party end-user auth—canonical identity = **LoopMessage recipient**                                                                                  |
| Database       | **Supabase Postgres**                                                                                                                                                      |
| Object storage | **AWS S3** (export bundles and operational backups per this ADR—not inbound media)                                                                                         |
| Backend shape  | **Modular monolith** (HTTP API + worker processes from one codebase)                                                                                                       |
| Workers        | **One worker process** runs **all** BullMQ job types (inbound pipeline, scheduled check-ins, export/delete, maintenance); **no** microservices unless future PRD justifies |


**Drivers:** fastest safe MVP delivery, **one** strong engineer, **low ops overhead**, clean extensibility without overengineering.

---

## Decision

We implement a **TypeScript/Node modular monolith** with **Fastify** for HTTP, **Redis + BullMQ** (or equivalent Node queue library) for durable jobs, **Supabase Postgres** via `**@supabase/supabase-js` + service role** (server-only), and **AWS S3** for export artifacts and CI database backups, with **S3-compatible local emulation** (MinIO or filesystem adapter) for development.

Detailed decisions are listed below and **together** constitute the accepted architecture.

### 1. Job queue and async spine

- **Redis** is the durable job layer (e.g. **BullMQ**).
- **Worker scope:** a **single worker deployment** consumes **all** queue job types for MVP—inbound continuation, scheduled check-ins, export/delete fulfillment, abandonment/purge, etc.—using separate queues or job names as an implementation detail. *“Check-ins-only worker” is not the model.*
- **Inbound pipeline (hybrid webhook):** **verify signature → persist idempotency for provider event id in Postgres (committed) → HTTP 2xx → enqueue** downstream work. **HTTP 2xx means** durable dedupe was recorded, **not** that LLM or outbound iMessage completed.
- **Enqueue failure after idempotency commit:** if **Redis enqueue fails**, return a **non-2xx** (e.g. **503**) so the provider **retries**; replays remain **safe** via stored event id. **Postgres outbox** as a fallback is **not** required for MVP.
- **Outbound** targets **at-least-once** processing with **retries**, **bounded backoff**, **dead-letter / failed-job path**, and **stalled job** handling per BullMQ. **Idempotency keys** protect externally visible effects (e.g. sends).
- **Queue failure policy:** bounded retries with exponential backoff; exhausted jobs go to DLQ/failed path with metadata; **no infinite** poison retries; **manual/minimal replay** acceptable for MVP.

### 2. Deployment and environments

- **Staging/production:** **Render**—**two** long-running services: **HTTP API** (Fastify) and **background worker** (BullMQ consumer), plus **managed persistent Redis** (Render Redis or equivalent managed Redis).
- **Local development:** Redis (e.g. Docker) + **API + worker** + **tunnel** (ngrok/Cloudflare Tunnel) for LoopMessage webhooks; **no** reliance on free ephemeral Redis for durable behavior.
- **Secrets:** platform-native secrets for staging/prod; **gitignored** `.env` locally; **CI encrypted secrets** for migrations and deploys.

### 3. Runtime and HTTP

- **Language:** **TypeScript** on **Node.js** for **both** API and worker (**single repository**).
- **HTTP framework:** **Fastify**. Webhook routes preserve **raw request bodies** for signature verification before JSON parsing.

### 4. Scheduling and time-based work

- **Queue-native scheduling:** BullMQ **repeatable** and **delayed** jobs.
- **Schedule persistence (hybrid model):** persist **schedule inputs** in Postgres (timezone, quiet hours, cadence/recurrence as modeled in MVP, export-related **scheduler fields** per Q6.R2) **and** maintain a **derived** “next run” timestamp (or equivalent) for efficient due processing; **recompute** that derived field in **one code path** on pause, snooze, schedule edit, or goal changes to avoid drift.
- **Postgres** is the **source of truth** for schedule state, pauses, quiet hours, eligibility.
- **Missed windows** are recorded per product rules (Q12.3); streak/accountability logic accounts for them—no pretending a send occurred.

### 5. Inbound webhook trust (LoopMessage)

- **Authenticate** every webhook using **LoopMessage’s documented** signing scheme (**HMAC/signature over the raw body** unless their docs specify otherwise).
- **Order:** **verify signature → persist idempotency (provider event id) in Postgres and commit → HTTP 2xx → enqueue**. Invalid signatures: **4xx**, **no** enqueue. **Dedupe must be durable before 2xx** so provider retries do not double-process side effects.
- **URL secrecy is not** a substitute for verification.
- **Integration-time only (no extra ADR fork):** exact headers, encoding, **which field is the stable event id**, and any **timestamp/replay** rules follow **current LoopMessage docs** as implemented—**not** pre-locked in this ADR (product choice: skip workshop detail; verify during build).

### 6. Data access and migrations

- **Client:** `@supabase/supabase-js` with **service role** key—**server processes only**; never browser or marketing bundles.
- **Migrations:** versioned **Supabase migrations** in git; applied by **CI/CD** as an explicit release step (**staging before production**). **Application instances do not run migrations on boot.**
- **Isolation:** with service role, **RLS must not be assumed** to enforce tenant boundaries—**recipient scoping** is enforced in **application code**.

### 7. Object storage (S3)

- **Scope (aligned with resolved architecture intake):** S3 holds **two** approved purposes per environment: **user export artifacts** and **CI-produced database backup artifacts**, isolated by **key prefix** and IAM—not “export-only” storage in the narrow sense.
- **Production/staging:** real **AWS S3** with **scoped IAM user credentials** in secrets; **least privilege** on **one bucket per environment** with **prefix separation**:
  - **User export bundles** (product)
  - **Database backup artifacts** (operations)
- **Presigned GET** for export download; TTL aligned with product defaults (e.g. ~24h from send).
- **Account deletion** removes user-owned S3 objects per application scope (Q10.R1).
- **Development:** **no AWS account required** initially—use **MinIO** (S3-compatible) or a **filesystem-backed** storage adapter behind the same interface; **first real S3 validation** in **staging**.
- **Post-MVP hardening:** OIDC/assume-role instead of long-lived keys—optional.

### 8. LLM integration

- **Internal LLM port** + **OpenRouter adapter**: **OpenRouter** as unified LLM gateway; handles provider routing, model selection, and failover internally. Primary and fallback model IDs configured via env (e.g. `anthropic/claude-sonnet-4-6`, `openai/gpt-4o`); single `OPENROUTER_API_KEY`. Uses the `openai` npm package with a custom `baseURL` — no `@anthropic-ai/sdk` required.
- **Domain modules** do **not** import vendor SDKs directly.
- **NLU / accountability intent (Q3.3):** MVP uses **structured output from the primary LLM path** (e.g. JSON schema or tool contract) to classify **done vs not done** (and similar) alongside conversational output—not a separate NLU microservice; optional keyword guardrails only.
- **Operational toggles (Q11.3):** **hybrid**—**database-backed flags** (with short in-process cache) for normal operation; **environment variables** as **hard override** (**env wins**). No public end-user API for flags in MVP.

### 9. Public web and abuse controls

- **Marketing + utility site** (landing, deep links, export/delete OTP forms) is hosted on **Vercel**; it calls **Fastify** on **Render** over HTTPS from the browser.
- **CORS** allowlists known **Vercel production** and **preview/staging** origins (and local dev as needed).
- **OTP** flows: **Cloudflare Turnstile** (server verify) on OTP **request** + **per-recipient** send caps (**Q4.R4**); **unknown recipients** rejected **without enumeration** (Q4.R2). **MVP:** **no separate per-IP** rate limit on the OTP *request* route—**add Redis-backed per-IP limits post-MVP** if metrics show abuse. Other abuse-sensitive routes may still use **Redis-backed** limits where needed.
- **Rate limiting:** **Redis-backed** counters on routes that use them (staging/prod); local dev may use in-memory; **fail closed** if Redis is unavailable **on those routes**. (OTP *request* has **no** per-IP limit in MVP—see above.)

### 10. Observability

- **Structured JSON logging** (e.g. Pino) from API and worker.
- **Error tracking:** **Sentry** in staging/production (separate environments or projects per stage) with scrubbing aligned to **Q10.3** intent: **do not** log full message bodies, OTPs, presigned URLs, or raw webhook bodies in logs or error context; prefer **ids**.
- **OpenTelemetry:** **not** required for MVP.

### 11. Health, shutdown, and correlation

- **HTTP:** `/health` (liveness) and `/ready` or `/readiness` (Postgres + Redis).
- **Worker:** graceful shutdown—stop dequeuing, bounded wait for in-flight work, close connections; **minimal HTTP health** if the platform requires it.
- **Correlation:** accept/generate `**x-request-id`**; propagate to **BullMQ job metadata** and structured logs.

### 12. Backups and recovery

- **Custom backup pipeline** (in addition to relying on provider capabilities): **automated Postgres backups** executed by **scheduled CI** (not API/worker runtime), uploading artifacts to the **backup prefix** in the **environment’s S3 bucket**.
- **Recovery:** restore from backup artifacts + provider tooling as documented in ops runbooks; **RPO/RTO** bounded by Supabase plan + backup cadence.
- **Honesty:** vendor limits on LoopMessage and infra logs remain as stated in Q10.R1.

### 13. Proactive iMessage caps and adaptive throttling (Q8.2)

- **Enforced in MVP** with **config-backed** thresholds (environment and/or operational flags/DB), not “logging only.”
- **Initial defaults (workshop v1):** **≤8 proactive** iMessages **per user** per **rolling 24h**; **≥90 minutes** minimum spacing between proactive sends to the same user; **7-day** reply-rate window with **below 30%** threshold → **1.5×** multiplicative spacing backoff, **cap** maximum spacing at **48h**; always respect quiet hours and pause/snooze. **“Proactive”** excludes **immediate replies** tied to the current inbound turn (scheduled/nudge class only).
- **Tune** after observing reply patterns and sender reputation.
- **Adaptive throttling** when reply rate drops is separate from **BullMQ job retry** backoff (which applies to send/job failures).

### 14. Implementation workshop resolutions (March 2026)

Recorded **after** ADR acceptance to pin MVP implementation choices that were still open in prose:


| Topic                                  | Resolution                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LLM gateway**                        | **OpenRouter** — unified gateway; single `OPENROUTER_API_KEY`; primary + fallback model IDs configured (`OPENROUTER_PRIMARY_MODEL` / `OPENROUTER_FALLBACK_MODEL`); provider routing and failover handled by OpenRouter internally via `models` array.                                                                                                                                                           |
| **Compute**                            | **Render:** web service (API) + **background worker** + **managed Redis**.                                                                                                                                                                                                                                                                                                                                      |
| **Public web hosting**                 | **Vercel** for marketing + utility forms; **CORS** allowlists Vercel origins.                                                                                                                                                                                                                                                                                                                                   |
| **Bot friction**                       | **Cloudflare Turnstile** on OTP request path; server-side siteverify before sending OTP.                                                                                                                                                                                                                                                                                                                        |
| **Error tracking**                     | **Sentry** (API + worker), scrubbed per Q10.3.                                                                                                                                                                                                                                                                                                                                                                  |
| **LoopMessage topology**               | Still **one LoopMessage project** per Q5.1; **strict guardrails:** separate **Supabase + Redis + Render** stacks per environment; **no production LoopMessage credentials** in non-prod; **non-prod outbound iMessage allowlist** only (enforced in application code).                                                                                                                                          |
| **Export / delete fulfillment**        | **Fully automated** via worker jobs after OTP verification; **manual runbook** only for DLQ / exhausted retries (exception path).                                                                                                                                                                                                                                                                               |
| **Export/delete SLA “business hours”** | Implement as **three (3) US business days** in `**America/New_York`**, Mon–Fri only, deadline **23:59:59 ET** on the third business day; **inclusive** counting from verification **calendar date** in ET (if weekend, first business day is next Monday). Public copy: prefer **“within 3 business days”** over ambiguous “72 business hours.” **US federal holidays:** not excluded in v1 unless added later. |
| **OTP request per-IP rate limits**     | **Skipped for MVP.** Rely on **Turnstile** + **Q4.R4** (max **3** OTP **sends** per recipient per hour) + non-enumerating responses. **Post-MVP:** add **Redis-backed per-IP** windows on OTP *request* if abuse appears.                                                                                                                                                                                       |
| **LoopMessage webhook specifics**      | **No separate workshop lock.** Implement **signature verification**, **dedupe key**, and **replay/timestamp** behavior **exactly per LoopMessage documentation** during integration (see **§5**).                                                                                                                                                                                                               |


---

## Consequences

### Positive

- **Single codebase** and runtime reduce cognitive load and deployment complexity.
- **Redis** unifies **jobs**, **rate limits**, and **scheduling primitives**.
- **Clear security boundaries:** server-only secrets, verified webhooks, scoped S3 IAM.
- **Operational toggles** support incidents without always requiring redeploys.

### Negative / tradeoffs

- **Redis** is a **single point of dependency** for jobs and rate limits—monitoring and failover assumptions must be explicit.
- **Service role** Postgres access demands **disciplined** application-level scoping.
- **Custom backups + S3** add **ongoing** operational responsibility versus “managed backups only.”
- **Long-lived AWS keys** (until OIDC) require **rotation discipline**.

---

## Options considered (summary)


| Topic            | Alternatives                   | Outcome                                                   |
| ---------------- | ------------------------------ | --------------------------------------------------------- |
| Queue            | SQS, managed workflow products | Redis + BullMQ                                            |
| Hosting          | AWS ECS/K8s, Railway           | **Render** (web + worker + Redis)                         |
| DB access        | Drizzle/Prisma direct          | Supabase JS + service role                                |
| HTTP             | Hono, Express                  | Fastify                                                   |
| Scheduling       | DB polling only                | Queue-native repeatable/delayed                           |
| S3 dev           | Always real AWS                | MinIO / filesystem adapter                                |
| LLM              | Direct SDK in handlers         | Port + adapters + router                                  |
| Toggles          | Env-only                       | Hybrid DB + env override                                  |
| Rate limits      | In-memory only                 | Redis-backed (prod)                                       |
| Backups          | Provider-default only          | Custom + CI-scheduled dumps to S3                         |
| Correlation      | None                           | `x-request-id` end-to-end                                 |
| Webhook ACK      | 2xx before durable dedupe      | Dedupe committed in Postgres before 2xx                   |
| Enqueue failure  | Silent 2xx                     | 5xx to trigger provider retry                             |
| Worker jobs      | Check-ins only                 | All job types in one worker                               |
| NLU              | Separate service               | Structured output on primary LLM path                     |
| Schedule storage | Timestamps only vs rules only  | Hybrid: inputs + cached next run                          |
| Proactive policy | Defer enforcement              | Config + loose defaults + exponential backoff on throttle |


---

## Open questions and vendor verification

Remaining **product / scope** items (not pre-decided here):

1. **Freemium numeric caps** and transition from **soft** to **hard** enforcement—product/config (see intake).
2. **Postgres outbox** (durably queue work if Redis is down at enqueue time): **explicitly out of scope for MVP**—use **5xx + provider retry** after idempotency commit (§1).

**LoopMessage webhook** signing, event id field, and replay rules: **integration task** against vendor docs—**no additional architecture decision** recorded (see **§5**, **§14**).

---

## References

- [clarification-answers.md](./clarification-answers.md)
- [resolved-architecture-intake.md](./resolved-architecture-intake.md)
- LoopMessage API docs: [https://docs.loopmessage.com/](https://docs.loopmessage.com/)

---

## Related documents

- This ADR **supersedes** informal workshop notes; future ADRs should **amend** this file or add `adr-00x-…` for major changes (e.g. split services, auth model change).

