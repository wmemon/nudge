# Folder Structure Design Document (DreamLaunch MVP Backend)

## 1. Document Purpose
- Define the standard backend folder structure for DreamLaunch MVPs built as a modular monolith with a single worker deployment boundary.
- Provide a reusable structure that prioritizes speed, clarity, and maintainability for one strong developer plus AI.
- Establish folder, dependency, and naming guardrails so implementation choices stay aligned with approved architecture and constraints.
- Show how the current AI Accountability Companion MVP maps into the standard without defining API contracts, payloads, or full data models.

## 2. Folder Structure Design Principles
- **Module-first organization:** Organize by business capability (bounded context), not package-by-layer across the entire codebase.
- **MVP simplicity rule:** Start with the thinnest structure that preserves boundaries; avoid speculative abstractions for future scale.
- **Architecture-to-code mapping:**  
  - Modular monolith -> `src/modules/*` plus shared platform runtime.
  - Single worker boundary -> one `src/worker` runtime handling all async job types.
  - External integrations behind adapters -> `src/platform/*` ports/adapters used by modules.
- **Boundary clarity over purity:** Small duplication across modules is acceptable if it avoids premature shared abstractions.
- **Shared promotion threshold:** Promote code to `src/shared` only when it is reused by **2+ modules** and has **stable, domain-neutral** semantics.

## 3. Standard Reusable Top-Level Shell
- `src/app`  
  HTTP app composition, bootstrap wiring, middleware registration, route mounting, health/readiness endpoints.
- `src/modules`  
  Business modules (feature/bounded-context folders); primary place for domain logic and use-case orchestration.
- `src/platform`  
  Infrastructure and external adapters (database client setup, queue client setup, storage clients, provider adapters, observability wiring, config loader).
- `src/shared`  
  Cross-cutting, neutral primitives reused by multiple modules (types, validation helpers, errors, id generation, correlation helpers).
- `src/worker`  
  Worker runtime entrypoint, job registration/dispatch, graceful shutdown/drain handling for all async workloads.
- `src/scripts`  
  Operational and developer scripts only — **non-runtime** (maintenance commands, one-off ops utilities, developer helpers). All production runtime behavior stays in `app`, `modules`, `platform`, and `worker`.
- `tests`  
  Automated tests split by slice/integration/system support, aligned to module and boundary risks.
- `docs`  
  Architecture/constraints/runbooks/decision records; no runtime code.

## 4. Standard Module Template
- Standard module path: `src/modules/<module-name>/`
- **Standard internal subfolders:**
  - `domain` - business rules, core invariants, value transformations, policy logic.
  - `adapters` - module-local ingress/egress adapters (for example HTTP handlers, queue handlers, mapping at module boundary).
  - `data-access` - repository/query logic for module-owned persistence interactions.
  - `application` - use-case orchestration and transaction-level flow across domain + ports.
- **`application` (MVP):** Optional only for **trivially thin** flows: pure pass-through with **no** branching, **no** policy decisions, and **no** transaction coordination. Introduce `application` **immediately** when any of those appear. When omitted, **`adapters` may call `domain` directly** (validation at ingress still required).
- **Optional internal subfolders** (add only when they remove real ambiguity or improve maintainability):
  - `contracts` - local DTO shapes for module boundary when needed for clarity.
  - `jobs` - module job producers/consumers registration helpers when async needs are non-trivial.
  - `policies` - isolated policy components if policy logic grows beyond simple domain files.
  - `__tests__` - module-local test fixtures/unit tests when colocated tests improve maintenance.
- **MVP layer omission rules (allowed):**
  - Omit `data-access` only for modules with no persistence responsibilities.
  - Omit `jobs` when module has no async behavior.
  - Never omit `domain` for business modules that encode user-visible behavior.

## 5. Platform / Shared / Module-Local Rules
- **Belongs in `src/platform`:**
  - Vendor SDK wiring (LoopMessage, LLM vendors, S3, Redis/BullMQ, Supabase client).
  - Infrastructure lifecycle concerns (connection setup, retries at adapter edge, boot-time validation, environment config).
  - Observability providers and integration-specific instrumentation (Sentry/log transport wiring).
- **Belongs in `src/shared`:**
  - Domain-neutral utilities with proven multi-module reuse.
  - Common validation primitives and typed error envelopes that do not encode module business semantics.
  - Request/job correlation helpers and safe logging redaction utilities.
- **Must stay module-local (`src/modules/<name>`):**
  - Business rules, workflow policy, eligibility checks, and user-facing behavior decisions.
  - Module persistence queries specific to that module’s use-cases.
  - Provider payload normalization decisions tied to module business semantics.
- **Hard rules (MVP):**
  - **No** business or policy logic in `src/platform` or `src/shared`.
  - **No** vendor SDK imports in module `domain` or `application` code (use platform adapters / ports).
- **Anti-patterns to avoid:**
  - `shared` becoming a dumping ground for module logic.
  - Modules bypassing their own boundaries to call another module’s repositories directly.
  - Vendor SDK imports in domain/application code.
  - Platform folders owning business decisions.

## 6. Dependency Rules
- **Allowed dependency direction:**
  - `app` -> `modules`, `platform`, `shared`
  - `worker` -> `modules`, `platform`, `shared`
  - `modules/*/adapters` -> `modules/*/application` -> `modules/*/domain` (when `application` exists)
  - `modules/*/adapters` -> `modules/*/domain` when `application` is omitted under MVP thin-flow rules
  - `modules/*/(application|data-access|adapters)` -> `platform` through declared ports/interfaces
  - `modules/*` -> `shared` (neutral helpers only)
- **Forbidden shortcuts:**
  - No `module A` direct imports from `module B` internal `data-access` (or other internal paths).
  - No `domain` importing vendor SDKs, platform concrete adapters, **`adapters`**, or **`data-access`**.
  - No ingress adapter skipping validation before domain entry.
- **Cross-module communication (strict):** Interaction between modules must go through **explicitly exported** application-level services/functions from the callee module’s public surface (for example `index.ts`). Never reach into another module’s internals.
- **Adapter rules:**
  - External provider specifics are translated at adapter boundaries; module internals consume normalized shapes.
  - Adapter failure semantics and expectations are documented near code/PR before merge.
- **Module communication:**
  - Use queue-mediated async communication for decoupled flows where appropriate; stay within single worker runtime boundary.
  - Avoid event contracts that imply distributed-system complexity for MVP.

## 7. Naming and Organization Rules
- **Module naming:** use singular, business-capability names in kebab-case (for example `goal-management`, `webhook-ingestion`).
- **File/folder naming:** kebab-case for folders/files.
- **Layer suffixes (mandatory in `application`, `adapters`, `data-access`):** use descriptive suffixes for role (`*-service.ts`, `*-repository.ts`, `*-adapter.ts`, `*-validator.ts`). In `domain`, prefer **business-first** names; suffixes are optional when they do not help clarity.
- **Module public boundary:** each module exposes its stable API through **`index.ts`** at the module root.
- **Runtime entrypoints:** keep explicit bootstrap names (`http-server.ts`, `worker-runner.ts`, `config.ts`).
- **Architecture mapping convention:**
  - Domain building blocks -> `domain/*`
  - Use-case orchestration -> `application/*`
  - External boundary handling -> `adapters/*`
  - Persistence interaction -> `data-access/*`
  - Infra providers/integrations -> `platform/*`
- **Organization rule:** do not create extra folder layers unless they remove real ambiguity in current MVP code.

## 8. Testing and Support Layout
- `tests/slices/<module-name>/`  
  Fast, boundary-oriented slice tests for module behavior with lightweight fakes.
- `tests/integration/`  
  Integration tests for high-risk boundaries (webhook trust/idempotency order, enqueue-failure behavior, retry/backoff/DLQ paths, deletion side-effects).
- `tests/platform/`  
  Adapter/infrastructure tests for provider edges and config/startup validation.
- `tests/fixtures/`  
  Shared fixtures/test builders with neutral data helpers.
- `src/scripts/`  
  Operational helpers (replay helpers, maintenance checks, export/delete diagnostics, migration support scripts where applicable).
- `docs/runbooks/` (optional subfolder)  
  Operational runbooks for DLQ handling, recovery, and incident procedures.
- **MVP minimum test gate:**
  - Each **active module** (any module with a **production HTTP route** or **worker job handler**) has at least **one** slice test under `tests/slices/<module-name>/`.
  - Each **critical async flow** has at least **one** integration test under `tests/integration/`.

## 9. Project-Specific Mapping for This MVP
- **Likely MVP modules in `src/modules`:**
  - `identity-recipient` - canonical recipient identity persistence (E-RECIPIENT); sole write authority for creating and managing recipient records; all other modules reference recipients through this module's exported API. **Locked as the authoritative owner of E-RECIPIENT per data-model-and-ownership-mvp-backend.md.**
  - `webhook-ingestion` - LoopMessage inbound trust verification flow, durable idempotency decision path, enqueue handoff orchestration.
  - `conversation-accountability` - conversational turn handling, accountability intent outcomes, streak/accountability policy decisions.
  - `goal-scheduling` - goal lifecycle, quiet-hours/cadence inputs, next-run recalculation orchestration.
  - `outbound-messaging` - outbound send orchestration with idempotency safeguards and provider-independent send intents.
  - `otp-verification` - OTP request/verify flows for export/delete rights verification.
  - `user-rights-ops` - export generation triggers, delete lifecycle orchestration, fulfillment status policy.
  - `proactive-policy` - proactive caps/throttling policy decisions and guard enforcement hooks.
  - `abandonment-lifecycle` - 7-day outbound stop and 90-day pre-goal purge rules.
  - `usage-metering` - freemium usage counters, limit-threshold evaluation, and soft-warning signals (narrow MVP scope: no billing; hard numeric caps and enforcement flip remain product-owned).
- **Module naming:** treat the listed names as **default** implementation boundaries; **rename only** when bounded-context evidence from implementation shows a mismatch. The names **`usage-metering`** and **`identity-recipient`** are **locked**.
- **Platform mapping in `src/platform`:**
  - `config`, `db-supabase`, `queue-bullmq`, `storage-s3`, `loopmessage-adapter`, `llm-router`, `turnstile-verify`, `toggles`, `observability`.
- **Worker mapping in `src/worker`:**
  - Single runtime registering all job categories (inbound continuation, scheduling, export/delete, maintenance/cleanup) with one deployment boundary.
- **Deferred for MVP (not required in structure now):**
  - Admin/support console module.
  - Product analytics pipeline module.
  - Non-iMessage channel modules.
  - Microservice split or multi-worker topology.
  - Post-MVP per-IP OTP request throttling layer.

## 10. Open Items / Decisions Still Needed
- No material blockers for folder-structure approval based on accepted ADR and implementation constraints.
- Non-blocking follow-ups:
  - Refine module naming only when **bounded-context evidence** from implementation requires it; **`usage-metering`** is locked as the freemium usage counter and limit-threshold policy module name.
  - Finalize **product-owned numeric freemium caps** and the **config/flag trigger** for moving from soft warnings to hard enforcement (see clarification answers and ADR open items).

## 11. Approval Summary
- This document defines a reusable, module-first backend shell for DreamLaunch MVPs that is consistent with the accepted modular monolith and single-worker architecture.
- It sets clear boundaries for modules, platform adapters, and shared utilities; enforces dependency direction, cross-module export discipline, and anti-coupling rules; and locates testing/support assets (including an MVP minimum test gate) for safe iteration.
- It maps the AI Accountability Companion MVP into that standard — including **`usage-metering`** — while explicitly deferring non-MVP capabilities and avoiding contract/data-model over-specification.

## 12. Proposed filename
- `docs/backend-folder-structure-design.md`
