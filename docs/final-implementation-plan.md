# Final Implementation Plan (DreamLaunch MVP Backend)

## 1. Document Purpose

- **What this document is for**: Convert approved architecture + constraints + contracts + data ownership into a **buildable, dependency-ordered execution sequence** for one strong developer + AI.
- **How it should be used during implementation**:
  - Treat **Build Phases** as the required order of work and review gates.
  - Treat **Vertical Slices** as the main unit of incremental delivery (each slice produces an end-to-end runnable path).
  - Use **Sequencing rules**, **migration ordering**, **test checkpoints**, and **review gates** as stop/go criteria before progressing.

## 2. Source-of-Truth Order

Implementation must follow this precedence (higher wins on conflict):

1. `docs/adr-001-backend-mvp-architecture.md`
2. `docs/implementation-constraints.md`
3. `docs/backend-folder-structure-design.md`
4. `docs/contracts-first-mvp-backend.md`
5. `docs/data-model-and-ownership-mvp-backend.md`
6. `docs/PRD.md`
7. `docs/clarification-answers.md`
8. `docs/resolved-architecture-intake.md`

Conflict resolution:

- **If anything disagrees**, implement the higher-priority document.
- Contracts/data ownership are **locked as written**; this plan sequences delivery only.

## 3. Scope and Boundaries

- **Approved MVP scope (must implement)**:
  - **Modular monolith** (TypeScript/Node) with **Fastify** HTTP API and **one worker deployment boundary** consuming all job types.
  - **Supabase Postgres** as authoritative app datastore (service role server-side; do not assume RLS).
  - **Redis + BullMQ** durable async spine (jobs + scheduling primitives + rate-limit counters where used).
  - **LoopMessage** inbound webhook: verify signature on raw body; durable idempotency record in Postgres; 2xx; then enqueue; enqueue failure after commit => non-2xx (e.g. 503) to trigger retries.
  - **Scheduled check-ins** via BullMQ repeatable/delayed jobs; Postgres source-of-truth schedule inputs + derived “next run” maintained by one recompute path.
  - **Proactive caps + adaptive throttling** enforcement (config-backed; defaults per ADR).
  - **Utility web flows** (Vercel browser -> Render API): Turnstile-protected OTP request; OTP verify issues an opaque bearer token; export/delete endpoints accept token and enqueue jobs.
  - **Export** bundle to S3 (user export prefix), send iMessage with presigned URL TTL ~24h; export contents per Q6.R2.
  - **Account deletion**: delete Supabase rows for recipient, delete user-owned S3 objects, cancel pending jobs; honesty about vendor-side retention.
  - **Abandonment/purge**: 7-day stop outbound if no goal; 90-day purge pre-goal inactive.
  - **Observability**: structured JSON logs, request/job correlation, Sentry with strict scrubbing.
  - **Backups**: CI-scheduled Postgres backups uploaded to S3 backup prefix (ops artifact, not product flow).

- **Deferred scope (must not implement in MVP)**:
  - Any end-user auth (Clerk/third-party), admin/support console, analytics pipeline.
  - Postgres outbox pattern for enqueue fallback.
  - Per-IP OTP request rate limiting (explicitly deferred; Turnstile + per-recipient OTP send caps only).
  - Single-use export download gate (multiple downloads allowed until presigned expiry).
  - Additional channels beyond iMessage.

- **Assumptions still in effect**:
  - “Inbound activity” for 90-day purge means **any inbound message** unless clarified later.
  - “72 business hours” SLA is implemented as **3 US business days** in `America/New_York` with deadline EOD on the 3rd business day; federal holidays not excluded.
  - LoopMessage webhook wire details (headers, event-id path, replay/timestamp policy) are implemented **per vendor docs** and recorded as an adapter contract note before production cutover.

## 4. Build Phases

### PH-00 — Project + environment scaffolding

- **Objective**: Establish repo structure, environments, and operational guardrails so subsequent slices are buildable without rework.
- **Why this phase comes now**: Prevent cross-environment credential leaks, ensure deploy targets exist, and avoid rewriting foundations mid-sprint.
- **Major outputs**:
  - Folder structure aligned to `docs/backend-folder-structure-design.md`.
  - Environment inventory: local, staging, production.
  - Render services planned: API + worker; managed Redis; Supabase projects per env; S3 buckets per env with export/backup prefixes.
  - Secrets/config categories identified and validated at startup (no runtime surprises).
- **Prerequisites**: None.
- **Dependencies**: ADR + constraints.
- **Done criteria**:
  - Environments exist or are ready to provision; secrets categories defined; non-prod LoopMessage allowlist policy defined.
- **Status**: Approved candidate.

### PH-01 — Platform foundations (config, DB, Redis/queue, logging, health)

- **Objective**: Create the runtime “spine” used by every vertical slice: config loader, Postgres access layer, Redis/BullMQ clients, observability, health/readiness.
- **Why this phase comes now**: All slices depend on stable, tested platform wiring; prevents duplicative ad-hoc clients.
- **Major outputs**:
  - Startup config validation and env hard-overrides for operational toggles.
  - Supabase service-role access wrapper (server-only).
  - Redis + BullMQ queues and worker runtime skeleton (single worker boundary).
  - `/health` and `/ready` endpoints behavior per contracts.
  - Structured logging + correlation ID propagation conventions; Sentry wiring (staging/prod).
- **Prerequisites**: PH-00.
- **Dependencies**: Contracts-first (health/ready), constraints (OAC, DPC).
- **Done criteria**:
  - API and worker can start locally; readiness accurately reflects Postgres+Redis; correlation id shows in logs and job metadata.
- **Status**: Approved candidate.

### PH-02 — Inbound webhook trust + durable idempotency + enqueue handoff

- **Objective**: Implement LoopMessage webhook boundary exactly as required: signature verification, durable dedupe record, ACK semantics, and enqueue rules.
- **Why this phase comes now**: Highest-risk integration boundary; unlocks end-to-end inbound processing slices safely.
- **Major outputs**:
  - Webhook handler preserves raw body for verification.
  - Durable idempotency record keyed by provider event id committed before 2xx.
  - Enqueue continuation job; enqueue failure after commit returns non-2xx.
  - Minimal audit events for acceptance/duplicate/reject/enqueue-fail.
- **Prerequisites**: PH-01.
- **Dependencies**: ADR webhook ordering + constraints AIC-001/002.
- **Done criteria**:
  - Duplicate webhook deliveries do not double-process; invalid signature never enqueues; enqueue failure triggers provider retry behavior.
- **Status**: Approved candidate.

### PH-03 — Inbound continuation slice (conversation, NLU outcome, outbound reply)

- **Objective**: Process inbound messages asynchronously: persist conversation/message, call LLM via router (OpenAI primary, Anthropic fallback), derive structured outcomes, and send an outbound iMessage reply with idempotency.
- **Why this phase comes now**: Delivers the core value loop (reply turns per day) and validates end-to-end pipeline under at-least-once.
- **Major outputs**:
  - Worker handler for inbound continuation job.
  - Persistence for message history + structured NLU outcomes.
  - Outbound send orchestration with idempotency keys (avoid duplicate sends on retries).
  - Safe fallback behavior when LLM/provider fails (static fallback where appropriate + retry policy).
- **Prerequisites**: PH-02.
- **Dependencies**: ADR LLM adapter boundary + retry/DLQ rules.
- **Done criteria**:
  - End-to-end: webhook -> job -> DB writes -> outbound reply -> logs correlated; retries do not duplicate external sends.
- **Status**: Approved candidate.

### PH-04 — Goal onboarding completion + schedule persistence + check-in scheduler

- **Objective**: Implement “onboarding completes when first goal exists” and enable scheduled proactive check-ins driven by Postgres schedule inputs and derived next-run.
- **Why this phase comes now**: Proactive check-ins are the MVP’s second key behavior after conversational replies.
- **Major outputs**:
  - Goal lifecycle: one active goal per recipient; supersede previous goals.
  - Schedule inputs persistence (timezone/quiet hours/cadence) + derived next-run recompute.
  - BullMQ delayed/repeatable scheduling producing due check-in jobs.
  - Missed-window recording behavior for downtime.
- **Prerequisites**: PH-03.
- **Dependencies**: ADR scheduling hybrid model + “missed windows” rule.
- **Done criteria**:
  - Check-ins are only scheduled after goal exists; quiet hours honored; missed windows are recorded as missed.
- **Status**: Approved candidate.

### PH-05 — Proactive policy enforcement (caps + adaptive throttling)

- **Objective**: Enforce proactive sending limits and adaptive throttling to protect sender reputation.
- **Why this phase comes now**: Must exist before any meaningful proactive volume; prevents reputation harm.
- **Major outputs**:
  - Enforcement of proactive caps and minimum spacing.
  - Reply-rate window tracking and spacing backoff rules per ADR defaults.
  - Config/flag wiring (DB-backed toggles with env hard overrides).
- **Prerequisites**: PH-04.
- **Dependencies**: ADR §13 and ADR §8 toggles.
- **Done criteria**:
  - Proactive sends are blocked/delayed when policy says so; immediate replies to inbound do not count as “proactive.”
- **Status**: Approved candidate.

### PH-06 — Utility rights: OTP request/verify + export/delete enqueue

- **Objective**: Deliver the full user-rights surface (web OTP verification) and enqueue export/delete jobs.
- **Why this phase comes now**: Rights flows are high trust/safety requirements; must be correct before production.
- **Major outputs**:
  - OTP request: Turnstile verify; known-recipient-only; non-enumerating response; per-recipient OTP send caps.
  - OTP verify: 15-min validity, 5 attempts then invalidate; issues opaque bearer token.
  - Export/delete endpoints accept bearer token and enqueue respective jobs.
- **Prerequisites**: PH-01 and PH-03 (recipient existence + messaging).
- **Dependencies**: Contracts-first utility endpoints; clarification constraints for OTP.
- **Done criteria**:
  - Unknown recipients do not leak existence; abuse controls match constraints; enqueue semantics consistent with queue reliability rules.
- **Status**: Approved candidate.

### PH-07 — Export fulfillment (S3 artifact + iMessage link) + Delete fulfillment

- **Objective**: Implement worker jobs that fulfill export and deletion fully automatically with idempotent phases and DLQ handling.
- **Why this phase comes now**: Completes required rights outcomes; highest user trust impact.
- **Major outputs**:
  - Export job state tracking with SLA semantics (3 US business days ET).
  - Export bundle creation to S3 export prefix; presigned URL generation; iMessage delivery.
  - Delete job phased orchestration: delete Postgres rows, delete S3 objects, cancel pending jobs/scheduled sends; send optional confirmation if required by product copy (not mandatory).
  - Audit events for rights lifecycle outcomes.
- **Prerequisites**: PH-06.
- **Dependencies**: ADR S3 usage boundaries; deletion scope clarifications.
- **Done criteria**:
  - Export bundle matches required content scope; presigned link TTL enforced; deletion is safe under retries and removes user-owned S3 objects; pending jobs are cancelled.
- **Status**: Approved candidate.

### PH-08 — Abandonment/purge + backups + hardening + production readiness

- **Objective**: Add remaining time-based maintenance rules, operational backup pipeline, and “ship readiness” runbooks.
- **Why this phase comes now**: These are production safety requirements that should not block core behavior slices but must exist before launch.
- **Major outputs**:
  - 7-day stop automated outbound for pre-goal recipients; 90-day purge.
  - CI-scheduled Postgres backups to S3 backup prefix.
  - Runbooks: DLQ handling, export/delete failure recovery, restore procedure, secret rotation notes.
  - Final staging soak + launch checklist.
- **Prerequisites**: PH-03 through PH-07.
- **Dependencies**: ADR backup requirement; clarification abandonment rules.
- **Done criteria**:
  - Maintenance jobs verified in staging; backups run in CI; operational handoff notes exist.
- **Status**: Approved candidate.

## 5. Vertical Slice Plan

### VS-01 — “API+worker spine boots”

- **Which phase it belongs to**: PH-01
- **What it covers**: config validation, Supabase connectivity, Redis connectivity, BullMQ wiring, health/readiness, structured logs + request/job correlation.
- **Why it matters**: Makes everything else testable and deployable.
- **Review focus**: boundaries, secret hygiene, readiness accuracy, single-worker boundary.
- **Risks**: mis-scoped secrets; readiness false-positives.

### VS-02 — “LoopMessage webhook ACK correctness”

- **Which phase it belongs to**: PH-02
- **What it covers**: raw-body signature verify, Postgres idempotency commit before 2xx, enqueue, enqueue-failure semantics.
- **Why it matters**: Prevents duplicate side effects and ensures replay safety.
- **Review focus**: AIC-001/002 ordering, no vendor payload leakage past adapter boundary.
- **Risks**: incorrect raw-body handling; using wrong event id field.

### VS-03 — “Inbound message -> reply turn”

- **Which phase it belongs to**: PH-03
- **What it covers**: inbound continuation job, persistence of messages, LLM router call + structured outcome, outbound reply send with idempotency.
- **Why it matters**: Primary success metric is reply turns/day.
- **Review focus**: idempotency for outbound sends; failure fallback; scrubbing of content in logs.
- **Risks**: duplicate sends under retry; leaking message bodies into logs/Sentry.

### VS-04 — “Goal capture -> schedule -> check-in job”

- **Which phase it belongs to**: PH-04
- **What it covers**: one active goal invariant, schedule inputs + derived next run, due-job dispatch, quiet hours, missed-window recording.
- **Why it matters**: Enables proactive check-ins without breaking accountability semantics.
- **Review focus**: recompute path single-source; missed-window handling.
- **Risks**: schedule drift; sending during quiet hours.

### VS-05 — “Proactive policy gate”

- **Which phase it belongs to**: PH-05
- **What it covers**: caps/spacings, reply-rate window/backoff, config toggles.
- **Why it matters**: Protects sender reputation and platform viability.
- **Review focus**: definition of proactive vs immediate reply; correctness under retries.
- **Risks**: under-throttling; over-throttling harms engagement.

### VS-06 — “Web OTP -> verified token -> export/delete enqueue”

- **Which phase it belongs to**: PH-06
- **What it covers**: Turnstile, known-recipient-only non-enumeration, OTP rules, bearer token issuance, enqueue of export/delete.
- **Why it matters**: User rights and compliance trust surface.
- **Review focus**: enumeration safety; token binding to recipient + scope; rate limit correctness.
- **Risks**: privacy leaks; abuse of OTP endpoint.

### VS-07 — “Export fulfillment end-to-end”

- **Which phase it belongs to**: PH-07
- **What it covers**: export job tracking, S3 artifact, presigned URL, iMessage delivery.
- **Why it matters**: Required user rights outcome with strict expectations.
- **Review focus**: S3 prefix/IAM boundaries; content scope per Q6.R2; presigned TTL.
- **Risks**: accidental leakage via URL/logs; incorrect export contents.

### VS-08 — “Deletion fulfillment end-to-end”

- **Which phase it belongs to**: PH-07
- **What it covers**: deletion job phased idempotent saga, Postgres deletes, S3 object deletes, cancellation of pending jobs.
- **Why it matters**: Highest-trust operation; irreversibility requires safety.
- **Review focus**: ordering, idempotency, cancellation semantics, audit events.
- **Risks**: partial deletion; orphaned scheduled sends; rollback difficulty.

### VS-09 — “Abandonment + purge + backups + runbooks”

- **Which phase it belongs to**: PH-08
- **What it covers**: 7-day stop outbound, 90-day purge, CI backups to S3, operational docs.
- **Why it matters**: Prevents silent policy drift and reduces operational risk.
- **Review focus**: time computations in ET/timezone correctness; backup retention notes.
- **Risks**: unintended purges; backup restoration uncertainty.

## 6. Dependency and Sequencing Rules

- **Ordering rules**:
  - Platform foundations (config/DB/Redis/logging/health) must precede any business slice.
  - Webhook ACK semantics must be correct before enabling any downstream side-effectful pipeline.
  - Proactive scheduler must exist before rights exports/deletes only insofar as it shares job infrastructure; rights flows can proceed once queue + messaging exist.
  - Export/delete fulfillment must be implemented with idempotent phases before enabling in production.

- **Forbidden shortcuts**:
  - Do not ACK webhooks before durable dedupe commit.
  - Do not add a second worker deployment boundary for MVP.
  - Do not add third-party end-user auth.
  - Do not persist inbound image bytes to S3.
  - Do not introduce Postgres outbox to “improve reliability” (explicitly out of scope).
  - Do not add per-IP OTP request rate limits in MVP (unless there is an explicit approved change).

- **Parallelization guidance**:
  - While PH-02 is underway, draft tests and runbook skeletons in parallel (without blocking integration correctness).
  - Build export and deletion fulfillment in parallel only after token/rights model and storage prefixes are finalized.

- **Review stopping points**:
  - After PH-02 (webhook trust/idempotency): mandatory review gate.
  - Before enabling proactive scheduled sends in staging: mandatory review gate (caps/throttling correctness).
  - Before enabling export/delete in staging: mandatory review gate.

## 7. Migration / Data-Change Plan

- **Schema/data-change ordering**:
  - Establish core identity/recipient + webhook idempotency storage before webhook activation.
  - Add message history + NLU outcome persistence before enabling worker reply flows.
  - Add goal + schedule + missed-window persistence before scheduler jobs.
  - Add OTP sessions + rights sessions before exposing utility endpoints.
  - Add export/delete job tracking before fulfillment logic.

- **Risky changes to isolate**:
  - Any migration that changes uniqueness keys for provider event id, recipient identity, or outbound idempotency keys.
  - Deletion-related cascades/cleanup logic (ensure phased idempotency and dry-run validation in staging).
  - Schedule computation changes that affect quiet hours/timezone.

- **Rollback-sensitive areas**:
  - Webhook idempotency semantics: rollback must not reprocess previously ACKed provider events.
  - Export/delete state machines: rollback must not leave repeated side effects (duplicate exports, repeated deletion operations).
  - Proactive throttle state: rollback must fail safe (reduce sends, not increase) if uncertain.

## 8. Testing and Verification Plan

- **Testing layers expected**:
  - **Slice tests** per active module (minimum one per module with production route or job handler).
  - **Integration tests** for boundary-critical flows: webhook trust/idempotency; enqueue failure; retry/backoff; failed-job path; deletion side-effects.
  - **Platform tests** for config validation, readiness dependency checks, S3 prefix boundary behaviors.

- **Contract verification expectations**:
  - Verify each contract group in `docs/contracts-first-mvp-backend.md` is honored (health/ready, webhook semantics, OTP/rights flows).
  - Verify “do not leak” constraints: no vendor payload leakage into domain interfaces; strict ingress validation.

- **Integration/smoke expectations**:
  - Local: API + worker + Redis + Supabase; webhook tunnel; send/receive with LoopMessage sandbox/allowlisted contacts.
  - Staging: full end-to-end with non-prod allowlist enforced; verify presigned export downloads.

- **Verification checkpoints before moving phases**:
  - **After PH-02**: duplicate webhook delivery and enqueue-failure behavior proven.
  - **After PH-03**: at-least-once retry does not duplicate external sends; Sentry scrubbing verified.
  - **After PH-04/05**: scheduled send respects quiet hours and caps; missed windows recorded.
  - **After PH-06/07**: rights flows non-enumerating; export/delete completion verified with idempotent retries.

## 9. Review Gates During Build

- **Gate G0 (end of PH-01) — Foundations review (mandatory)**:
  - **What must be reviewed**: config validation, env hard-overrides, secret boundaries, readiness semantics, single worker boundary.
  - **Evidence needed**: startup validation output; readiness failing when dependencies down; correlation id propagation in logs.

- **Gate G1 (end of PH-02) — Webhook boundary correctness (mandatory)**:
  - **What must be reviewed**: raw-body signature verification; idempotency commit-before-ACK; 503 on enqueue failure after commit; vendor-specific parsing isolated.
  - **Evidence needed**: integration test(s) and staged replay scenario.

- **Gate G2 (end of PH-05) — Proactive safety gate (mandatory before proactive sends enabled in staging/prod)**:
  - **What must be reviewed**: proactive classification, caps, spacing, reply-rate throttling, quiet hours.
  - **Evidence needed**: deterministic tests or scripted scenarios; config toggles validated.

- **Gate G3 (end of PH-07) — Rights fulfillment gate (mandatory before enabling export/delete in staging/prod)**:
  - **What must be reviewed**: OTP non-enumeration, Turnstile verify, OTP attempt/send limits, export bundle scope, S3 prefix/IAM correctness, deletion completeness and job cancellation.
  - **Evidence needed**: end-to-end staging walkthrough + logs/audit events; failure-path test showing DLQ/runbook handling.

- **Gate G4 (end of PH-08) — Launch readiness gate (mandatory)**:
  - **What must be reviewed**: runbooks completeness, backups running, incident toggles, DLQ handling procedure.
  - **Evidence needed**: runbook docs present; backup artifact existence in S3 backup prefix; dry-run restore steps documented.

## 10. Acceptance Criteria / Definition of Done

The MVP backend is considered complete when:

- **Architecture compliance**: modular monolith with Fastify API + one worker boundary; Supabase Postgres + Redis/BullMQ + S3 used only as approved.
- **Webhook correctness**: signature verify; durable idempotency before 2xx; safe retry behavior; enqueue failure after commit returns non-2xx.
- **Core conversational loop**: inbound message produces stored message + structured outcome and sends a reply; retries do not duplicate sends.
- **Scheduling**: goal capture enables scheduled check-ins; quiet hours respected; missed windows recorded.
- **Proactive policy**: caps + adaptive throttling enforced per ADR defaults and configurable.
- **User rights**: OTP web flow works with Turnstile, non-enumeration, and limits; export produces correct bundle + iMessage presigned link; deletion removes app data, deletes user-owned S3 objects, cancels pending jobs.
- **Observability**: structured logs with correlation; Sentry enabled (staging/prod) with scrubbing; no sensitive logging.
- **Operations**: DLQ handling documented; CI backups to S3 backup prefix operational; basic health/readiness endpoints used in deploys.

## 11. Environment / Access / Configuration Prerequisites

- **Environments needed**: local, staging, production.

- **Environments/dependencies required before build**:
  - Supabase projects (staging + prod) and service-role keys.
  - Render (staging + prod) to create API service, worker service, and managed Redis.
  - AWS S3 (staging + prod) buckets and IAM credentials (least privilege; per-prefix).
  - LoopMessage account credentials; non-prod outbound allowlist test recipients.
  - Cloudflare Turnstile site/secret keys for OTP request.
  - Sentry project(s) for staging/prod.

- **Secrets/config categories**:
  - Database (Supabase URL + service role).
  - Redis connection.
  - LoopMessage API credentials + webhook signing secret/keys.
  - S3 credentials, bucket, prefixes, presign TTL policy.
  - LLM keys (OpenAI + Anthropic) and router settings.
  - Turnstile secret.
  - Sentry DSN + environment.
  - CORS allowlist for Vercel origins.
  - Safety toggles: non-prod allowlist enforcement; proactive caps; kill switch/degraded mode.

## 12. Risks, Rollback, and Runbook Notes

- **Top implementation risks**:
  - Webhook signature/idempotency mistakes causing duplicate side effects.
  - Outbound idempotency gaps causing duplicate iMessages under retries.
  - Quiet-hours/timezone bugs causing user harm/spam.
  - OTP enumeration or abuse vulnerabilities on utility endpoints.
  - Partial deletion leaving orphaned data or scheduled sends.

- **Rollback concerns**:
  - Webhook dedupe must remain stable across deploys; rollback must not “forget” dedupe decisions.
  - Export/delete jobs must be idempotent across retries and across deploy rollback.
  - Proactive throttling should fail safe (reduce sends) if uncertain.

- **Runbook / operational notes that must exist by handoff**:
  - DLQ/failed-job handling steps for each job category.
  - How to re-run an export/delete safely.
  - How to validate webhook signing configuration against vendor docs.
  - Backup cadence, retention expectations, and restore procedure.
  - Incident toggles: disable proactive sends; disable LLM calls (degraded mode); disable rights endpoints if abuse.

## 13. Open Items

Only items that materially block build approval:

- **Access provisioning**: staging/prod Supabase + Render + Redis + S3 + LoopMessage + Turnstile + Sentry access must be available to the implementer.
- **LoopMessage webhook wire details capture**: before production cutover, the adapter note must record the exact signature verification details and provider event-id path per current LoopMessage docs (required for correctness).

## 14. Build Start Recommendation

- **Yes with conditions**.
- **Brief explanation**: The architecture/constraints/contracts/data ownership are sufficiently locked to start building immediately, provided environment access is in place and the LoopMessage webhook wire details are confirmed from vendor docs during PH-02/PH-03 integration work.

## 15. Draft Approval Summary

- This plan sequences the accepted MVP backend into eight phases and nine vertical slices, prioritizing the highest-risk boundaries first (webhook idempotency/ACK, at-least-once outbound idempotency, proactive throttling, and rights flows).
- It includes explicit migration ordering, test checkpoints, mandatory review gates, and runbook/rollback notes, while respecting all locked decisions: no end-user auth, modular monolith, single worker boundary, Supabase Postgres + Redis/BullMQ + S3 scope limits, and utility OTP verification via web.

## 16. Proposed filename

- **Preferred**: `docs/final-implementation-plan.md`
- **Alternative** (if you want plans under Cursor): `.cursor/plans/final-implementation-plan.md`

