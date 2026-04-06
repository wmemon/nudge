# Final Implementation Constraints Document

## Document Purpose
- Establish binding, implementation-facing constraints for the MVP backend.
- Enforce ADR-approved architecture during build and review.
- Exclude API contract definitions and data ownership mappings.

## Source Basis and Precedence
- Primary source of truth: [docs/adr-001-backend-mvp-architecture.md](/Users/wasimmemon/Nudge/docs/adr-001-backend-mvp-architecture.md).
- Approved decision log: [docs/implementation-constraints-review-notes.md](/Users/wasimmemon/Nudge/docs/implementation-constraints-review-notes.md).
- Draft input used for phrasing continuity: [docs/implementation-constraints-review.md](/Users/wasimmemon/Nudge/docs/implementation-constraints-review.md).
- Conflict policy: ADR precedence is absolute.

## Constraints

### FPC-001
- **Constraint ID:** FPC-001
- **Constraint statement:** The MVP backend stack is fixed: no third-party end-user auth, Supabase Postgres, AWS S3, modular monolith, TypeScript/Node + Fastify, Redis/BullMQ queue spine, Render (API + worker), and Vercel for public web.
- **Why it exists:** Preserve the accepted MVP architecture and reduce decision churn.
- **Source basis:** ADR §Context, §Decision, §2, §3, §7, §9.
- **What it affects:** Technology selection, runtime shape, deployment choices.
- **How it will be enforced:** Architecture and PR review reject deviations not backed by ADR change.
- **Exception policy:** Requires ADR amendment.
- **Status:** Approved.

### FPC-002
- **Constraint ID:** FPC-002
- **Constraint statement:** MVP durable async execution remains one worker deployment boundary; multiple queues/job names are allowed within that single worker boundary.
- **Why it exists:** Keep operations simple while preserving async reliability.
- **Source basis:** ADR §1, §2; approved review-note clarification.
- **What it affects:** Worker topology, queue consumption, deployment boundaries.
- **How it will be enforced:** Deployment review verifies no worker-service split.
- **Exception policy:** Splitting workers/services requires ADR update.
- **Status:** Approved.

### FPC-003
- **Constraint ID:** FPC-003
- **Constraint statement:** S3 scope is limited to user export artifacts and operational backup artifacts by environment and prefix.
- **Why it exists:** Keep storage purpose bounded and auditable.
- **Source basis:** ADR §7, §12.
- **What it affects:** Export pipeline, backup pipeline, IAM/prefix structure.
- **How it will be enforced:** Persistence-path review and IAM/prefix checks.
- **Exception policy:** Requires ADR update for scope expansion.
- **Status:** Approved.

### FPC-004
- **Constraint ID:** FPC-004
- **Constraint statement:** No architecture split into microservices for MVP.
- **Why it exists:** Minimize ops complexity for single-team delivery.
- **Source basis:** ADR §Context, §2, §Options considered.
- **What it affects:** Service boundaries and deployment model.
- **How it will be enforced:** Architecture review blocks service-split proposals.
- **Exception policy:** Requires ADR amendment.
- **Status:** Approved.

### MBC-001
- **Constraint ID:** MBC-001
- **Constraint statement:** Controllers/route handlers remain thin orchestration layers; durable business rules belong in domain/application services.
- **Why it exists:** Preserve boundary clarity and avoid duplicated logic.
- **Source basis:** ADR modular monolith boundary intent.
- **What it affects:** HTTP/webhook handlers and service design.
- **How it will be enforced:** Review checklist for logic placement.
- **Exception policy:** Emergency hotfix only with tracked refactor follow-up.
- **Status:** Approved.

### MBC-002
- **Constraint ID:** MBC-002
- **Constraint statement:** Domain modules must not directly import provider SDKs; provider access must go through adapter ports.
- **Why it exists:** Prevent vendor coupling in core logic.
- **Source basis:** ADR §8 (port/adapters), §5, §7.
- **What it affects:** Domain services, integrations, outbound messaging.
- **How it will be enforced:** Import-boundary review and prohibited direct SDK usage in domain code.
- **Exception policy:** None for MVP.
- **Status:** Approved.

### MBC-003
- **Constraint ID:** MBC-003
- **Constraint statement:** Data access logic must remain in explicit server-side data-access layers; service-role access is never exposed to client-side assets.
- **Why it exists:** Prevent privilege leakage and preserve data-access discipline.
- **Source basis:** ADR §6.
- **What it affects:** Repository layers, web utilities, job processors.
- **How it will be enforced:** Server/client boundary checks and secret-scope review.
- **Exception policy:** None for MVP.
- **Status:** Approved.

### MBC-004
- **Constraint ID:** MBC-004
- **Constraint statement:** Shared code must stay cross-cutting and neutral, not a coupling backdoor between domains.
- **Why it exists:** Maintain modularity and reduce monolith tangling.
- **Source basis:** ADR maintainability goals.
- **What it affects:** Shared libs, middleware, utility modules.
- **How it will be enforced:** Review gate requires justification for new shared abstractions.
- **Exception policy:** Prefer small duplication over premature abstraction.
- **Status:** Approved.

### VID-001
- **Constraint ID:** VID-001
- **Constraint statement:** All external inputs (webhooks, utility forms, config/env, queue payload boundaries) must be validated at ingress before domain use.
- **Why it exists:** Prevent invalid/untrusted inputs from propagating.
- **Source basis:** ADR §5, §9.
- **What it affects:** Ingress handlers, queue consumers, utility flows.
- **How it will be enforced:** Boundary-validation review and invalid-input tests.
- **Exception policy:** None for externally sourced input.
- **Status:** Approved.

### VID-002
- **Constraint ID:** VID-002
- **Constraint statement:** Adapter input/output/failure expectations must be documented in code-adjacent docs or PR notes before merge.
- **Why it exists:** Keep integration assumptions explicit without heavyweight process.
- **Source basis:** ADR adapter discipline; approved review-note simplification.
- **What it affects:** LoopMessage, LLM, storage, and queue adapter changes.
- **How it will be enforced:** PR review requires linked contract expectation note before merge.
- **Exception policy:** Emergency temporary note allowed only with explicit expiry and follow-up.
- **Status:** Approved.

### VID-003
- **Constraint ID:** VID-003
- **Constraint statement:** Provider-specific parsing and normalization must stay inside provider adapter boundaries.
- **Why it exists:** Protect domain logic from vendor payload churn.
- **Source basis:** ADR §5, §8.
- **What it affects:** Inbound mapping, outbound formatting, provider metadata handling.
- **How it will be enforced:** Review blocks provider payload types leaking into domain interfaces.
- **Exception policy:** None for MVP.
- **Status:** Approved.

### DDC-001
- **Constraint ID:** DDC-001
- **Constraint statement:** Each business datum has one source of truth and one write-authority path.
- **Why it exists:** Avoid write conflicts and reconciliation ambiguity.
- **Source basis:** ADR schedule/persistence discipline.
- **What it affects:** Schedule state, OTP state, idempotency state, usage counters.
- **How it will be enforced:** Implementation notes and review require clear owner declaration.
- **Exception policy:** Temporary dual-write only with explicit rollback plan.
- **Status:** Approved.

### DDC-002
- **Constraint ID:** DDC-002
- **Constraint statement:** Data placement must follow approved storage-purpose boundaries (Postgres vs S3).
- **Why it exists:** Ensure retention/deletion correctness and intentional persistence.
- **Source basis:** ADR §6, §7.
- **What it affects:** Export, backup, media handling, deletion workflows.
- **How it will be enforced:** Review checks persistence paths against approved storage purpose.
- **Exception policy:** Requires architecture decision update for expansion.
- **Status:** Approved.

### DDC-003
- **Constraint ID:** DDC-003
- **Constraint statement:** Recipient scoping/isolation is enforced in application logic; do not rely on RLS assumptions under service-role usage.
- **Why it exists:** Prevent cross-recipient access under elevated credentials.
- **Source basis:** ADR §6.
- **What it affects:** Query filters, repositories, export/delete selection.
- **How it will be enforced:** Boundary-focused code review and negative leakage tests.
- **Exception policy:** None for MVP.
- **Status:** Approved.

### AIC-001
- **Constraint ID:** AIC-001
- **Constraint statement:** Webhook order is fixed: verify trust, durably record idempotency, ACK 2xx, then enqueue downstream processing.
- **Why it exists:** Ensure replay safety and side-effect dedupe.
- **Source basis:** ADR §1, §5.
- **What it affects:** Webhook endpoint flow and queue producer behavior.
- **How it will be enforced:** Integration tests for duplicate delivery and ACK semantics.
- **Exception policy:** None for MVP.
- **Status:** Approved.

### AIC-002
- **Constraint ID:** AIC-002
- **Constraint statement:** If enqueue fails after idempotency commit, return non-2xx to trigger provider retry.
- **Why it exists:** Preserve delivery reliability without introducing MVP outbox complexity.
- **Source basis:** ADR §1.
- **What it affects:** Webhook failure response and retry behavior.
- **How it will be enforced:** Failure-path tests and enqueue-error alerting.
- **Exception policy:** None for MVP.
- **Status:** Approved.

### AIC-003
- **Constraint ID:** AIC-003
- **Constraint statement:** Outbound side effects must be idempotency-protected with at-least-once processing, bounded retries/backoff, and failed-job/DLQ handling.
- **Why it exists:** Prevent silent drops and infinite poison retries.
- **Source basis:** ADR §1.
- **What it affects:** Outbound sends, export/delete jobs, maintenance jobs.
- **How it will be enforced:** Queue config review and retry/DLQ scenarios in tests.
- **Exception policy:** Infinite retries are prohibited.
- **Status:** Approved.

### AIC-004
- **Constraint ID:** AIC-004
- **Constraint statement:** Webhook signature/event-id/replay specifics must follow current vendor docs at integration time and remain adapter-isolated.
- **Why it exists:** Keep architecture stable while honoring vendor-wire truth.
- **Source basis:** ADR §5, §14.
- **What it affects:** LoopMessage inbound adapter and verification logic.
- **How it will be enforced:** Integration checklist references current vendor docs before production cutover.
- **Exception policy:** None.
- **Status:** Approved.

### AIC-005
- **Constraint ID:** AIC-005
- **Constraint statement:** Durable async ownership remains within one worker runtime boundary for MVP.
- **Why it exists:** Preserve operational simplicity and clear failure ownership.
- **Source basis:** ADR §1, §2; approved review-note clarification.
- **What it affects:** Consumer topology and deployment ownership.
- **How it will be enforced:** Topology lock checks in deploy review.
- **Exception policy:** Requires ADR update.
- **Status:** Approved.

### SPC-001
- **Constraint ID:** SPC-001
- **Constraint statement:** End-user identity remains conversation-based via LoopMessage recipient; no third-party user auth is added in MVP.
- **Why it exists:** Preserve approved identity model and scope.
- **Source basis:** ADR §Context and fixed stack.
- **What it affects:** Identity resolution and account operations.
- **How it will be enforced:** Scope review rejects new end-user auth dependencies.
- **Exception policy:** Requires ADR-level override.
- **Status:** Approved.

### SPC-002
- **Constraint ID:** SPC-002
- **Constraint statement:** Secrets are server-only and environment-scoped; production credentials must never be used in non-production.
- **Why it exists:** Prevent credential leakage and environment crossover.
- **Source basis:** ADR §2, §14.
- **What it affects:** Render/Vercel/CI configuration and local development handling.
- **How it will be enforced:** Secret inventory review and environment isolation checks.
- **Exception policy:** None for production secrets.
- **Status:** Approved.

### SPC-003
- **Constraint ID:** SPC-003
- **Constraint statement:** Storage access must follow least privilege by environment/prefix; presigned access remains time-bounded and purpose-limited.
- **Why it exists:** Limit blast radius and object exposure risk.
- **Source basis:** ADR §7.
- **What it affects:** IAM policy scope, export delivery, delete cleanup.
- **How it will be enforced:** IAM/policy review and access-path behavior tests.
- **Exception policy:** Broader access requires explicit security justification and approval.
- **Status:** Approved.

### SPC-004
- **Constraint ID:** SPC-004
- **Constraint statement:** Abuse-sensitive utility flows must apply approved anti-abuse controls and non-enumerating responses.
- **Why it exists:** Protect sender reputation and reduce abuse vectors.
- **Source basis:** ADR §9, §14.
- **What it affects:** OTP request/verify and export/delete request surfaces.
- **How it will be enforced:** Security scenarios for bot traffic and enumeration attempts.
- **Exception policy:** OTP-request per-IP limits remain deferred for MVP unless abuse metrics require escalation.
- **Status:** Approved.

### OAC-001
- **Constraint ID:** OAC-001
- **Constraint statement:** API and worker must emit structured logs with correlation IDs propagated across HTTP and queued jobs.
- **Why it exists:** Enable cross-boundary traceability.
- **Source basis:** ADR §10, §11.
- **What it affects:** Middleware, queue metadata, incident diagnostics.
- **How it will be enforced:** Log-shape and correlation-propagation checks.
- **Exception policy:** None for request/job paths.
- **Status:** Approved.

### OAC-002
- **Constraint ID:** OAC-002
- **Constraint statement:** Staging/production error tracking must use Sentry with strict scrubbing; sensitive content is excluded from logs/error context.
- **Why it exists:** Preserve debuggability without exposing sensitive data.
- **Source basis:** ADR §10.
- **What it affects:** Error handling, logging middleware, monitoring setup.
- **How it will be enforced:** Scrubbing policy checks and simulated error-path verification.
- **Exception policy:** No convenience exception for raw-content logging.
- **Status:** Approved.

### OAC-003
- **Constraint ID:** OAC-003
- **Constraint statement:** Minimum auditability must cover webhook acceptance/idempotency decisions, retry/exhaustion events, export/delete lifecycle, and account-deletion outcomes.
- **Why it exists:** Support operational and compliance-style accountability.
- **Source basis:** ADR §1, §10, §12, §14.
- **What it affects:** Operational event records and runbook diagnostics.
- **How it will be enforced:** Review checklist for mandatory lifecycle events.
- **Exception policy:** Missing required audit events blocks release for impacted flows.
- **Status:** Approved.

### TRC-001
- **Constraint ID:** TRC-001
- **Constraint statement:** Boundary-sensitive tests are mandatory for webhook trust/idempotency, enqueue-failure behavior, retry/backoff, and failed-job handling.
- **Why it exists:** Highest-risk failures occur at integration and async boundaries.
- **Source basis:** ADR §1, §5.
- **What it affects:** CI test suite and PR acceptance criteria.
- **How it will be enforced:** Merge gate requires boundary test coverage for changed flows.
- **Exception policy:** Temporary waiver requires explicit risk signoff and tracked debt.
- **Status:** Approved.

### TRC-002
- **Constraint ID:** TRC-002
- **Constraint statement:** Review must confirm contract-sensitive changes do not leak provider payloads into domain interfaces and do not bypass ingress validation.
- **Why it exists:** Prevent hidden coupling and brittle integrations.
- **Source basis:** ADR adapter and validation discipline.
- **What it affects:** Integration modules and PR review quality gates.
- **How it will be enforced:** PR checklist for boundary and contract impacts.
- **Exception policy:** None for boundary violations.
- **Status:** Approved.

### TRC-003
- **Constraint ID:** TRC-003
- **Constraint statement:** Regression coverage must include non-enumeration behavior and deletion-side effects (including pending-job cancellation and object-cleanup triggers) at policy level.
- **Why it exists:** Prevent privacy regressions in user-rights flows.
- **Source basis:** ADR §7, §9, §14.
- **What it affects:** OTP/export/delete and queue orchestration tests.
- **How it will be enforced:** Required scenario coverage attached to related PRs.
- **Exception policy:** None for privacy-critical paths.
- **Status:** Approved.

### DPC-001
- **Constraint ID:** DPC-001
- **Constraint statement:** Configuration must be explicit, environment-scoped, and startup-validated; where defined, environment hard-overrides win over dynamic flags.
- **Why it exists:** Keep runtime behavior predictable during incidents.
- **Source basis:** ADR §8 (operational toggles).
- **What it affects:** Config loader, feature toggles, deployment settings.
- **How it will be enforced:** Startup validation gate and config-inventory review.
- **Exception policy:** No implicit defaults for security/reliability-critical controls.
- **Status:** Approved.

### DPC-002
- **Constraint ID:** DPC-002
- **Constraint statement:** DB migrations are versioned and applied via CI/CD promotion order (staging before production); app boot must not auto-run migrations.
- **Why it exists:** Reduce migration risk and support controlled release operations.
- **Source basis:** ADR §6.
- **What it affects:** Migration flow and release process.
- **How it will be enforced:** Pipeline checks and release checklist requirements.
- **Exception policy:** Emergency hotfix migration requires explicit runbook and rollback note.
- **Status:** Approved.

### DPC-003
- **Constraint ID:** DPC-003
- **Constraint statement:** API must expose liveness and dependency readiness; worker must support graceful drain and required health signaling.
- **Why it exists:** Enable safe deploys and minimize dropped work on restart.
- **Source basis:** ADR §11.
- **What it affects:** Health endpoints, lifecycle hooks, deploy verification.
- **How it will be enforced:** Deployment checklist and restart-behavior tests.
- **Exception policy:** None for production services.
- **Status:** Approved.

### DPC-004
- **Constraint ID:** DPC-004
- **Constraint statement:** Non-production must enforce outbound recipient allowlisting and strict production-credential isolation.
- **Why it exists:** Prevent accidental non-prod sends to real users.
- **Source basis:** ADR §14 LoopMessage topology guardrails.
- **What it affects:** Environment config, outbound send guards, smoke tests.
- **How it will be enforced:** Startup safety checks and environment verification tests.
- **Exception policy:** None for MVP.
- **Status:** Approved.

## Deferred / Open Items (Accepted)
- Concrete API contracts and payload schemas are out of scope for this document.
- Concrete data ownership mappings are out of scope for this document.
- Freemium numeric caps and hard-enforcement thresholds remain open product inputs.

## Draft Approval Summary
- This version is approved as binding implementation constraints aligned to ADR-001 and the gated review notes.
- It preserves approved scope, including one-worker boundary clarification and simplified adapter-contract documentation requirement.
- It intentionally avoids reopening settled architecture decisions and avoids defining API contracts or data ownership mappings.

## Proposed Final Filename Under `docs`
- `docs/implementation-constraints.md`
