# Contracts-First Design Document (MVP Backend)

**Status:** Draft for approval  
**Scope:** AI Accountability Companion — Fastify API + single BullMQ worker on Render; utility flows from Vercel.

---

## 1. Document Purpose

- **What this is for:** Freeze **boundary agreements** (HTTP, webhooks, queue/job handoffs, validation and error shapes) so Fastify handlers, adapters, and the worker agree on ingress/egress behavior before schema-heavy implementation.
- **How to use it:** Treat each **Contract ID** as the review unit for PRs that touch that surface; add OpenAPI/JSON Schema or typed DTOs that **conform** to these summaries—do not expand scope without revisiting this document or [ADR 001](./adr-001-backend-mvp-architecture.md).

---

## 2. Source-of-Truth Order

1. [adr-001-backend-mvp-architecture.md](./adr-001-backend-mvp-architecture.md)
2. [implementation-constraints.md](./implementation-constraints.md)
3. [backend-folder-structure-design.md](./backend-folder-structure-design.md) *(replaces missing `folder-structure-design.md` in this repo)*
4. [prd.md](./prd.md)
5. [clarification-answers.md](./clarification-answers.md)
6. [resolved-architecture-intake.md](./resolved-architecture-intake.md)

**Conflict resolution:** Higher row wins. Example: [resolved-architecture-intake.md §17](./resolved-architecture-intake.md) locks MVP to **web-only OTP entry**—that wins over the older optional iMessage OTP verification row in clarifications.

---

## 3. Contract Design Principles

- **Design-first:** Implement handlers/adapters against these boundaries; avoid leaking vendor payloads into module `domain` (VID-003, MBC-002 per [implementation-constraints.md](./implementation-constraints.md)).
- **MVP scope:** Only contracts required for iMessage via LoopMessage, marketing/utility web calling Render, health/readiness, and single-worker async fulfillment—no speculative admin, analytics, or extra channels.
- **Consistency:** One JSON **error envelope** and one **correlation** story (`x-request-id` per ADR §11) across HTTP and job metadata (OAC-001).
- **Validation-at-boundary:** All external input validated at ingress before domain use (VID-001); unknown or unsafe fields handled per §7.
- **Idempotency / retry:** Webhook: **verify signature → durable provider-event dedupe in Postgres → 2xx → enqueue** (AIC-001); **enqueue failure after commit → non-2xx** (e.g. 503) for provider retry (AIC-002). Queue: **at-least-once** with **idempotency keys** for externally visible effects (AIC-003). Postgres **outbox** is out of scope for MVP (ADR §1).

---

## 4. HTTP/API Contract Catalog

**Global defaults**

- **Content-Type:** `application/json` for request bodies where a body exists.
- **Correlation:** Accept `x-request-id` from client; else generate; echo on responses where practical; attach to logs and BullMQ job metadata.
- **CORS:** Allowlist Vercel production, preview/staging, and local dev origins. Utility clients use **`Authorization: Bearer <opaque>`** (see §8)—use **`credentials: 'omit'`** on browser `fetch` / no cookie session for MVP utility flows.

---

### API-HLTH-001 — `GET /health`

- **Why:** Liveness for the platform (ADR §11).
- **Auth:** None (public).
- **Request:** Empty.
- **Response:** **200** — small JSON or plain body indicating process is up; **no** dependency checks.
- **Errors:** N/A for liveness (always **200** while process serves the route).
- **Validation:** None.
- **Status:** Approved candidate.

---

### API-HLTH-002 — `GET /ready` (alias `/readiness` optional; pick one canonical path per deployment)

- **Why:** Readiness for deploy/traffic (Postgres + Redis) (ADR §11).
- **Auth:** **None (public).** Render/platform probes use unauthenticated GET; rely on obscurity + rate limits if needed—not a substitute for app security elsewhere.
- **Request:** Empty.
- **Response:** **200** when Postgres and Redis are reachable within bounded timeouts; **503** when either dependency fails.
- **Errors:** **503** with safe error envelope when unhealthy.
- **Validation:** None.
- **Status:** Approved candidate.

---

### API-WH-001 — `POST /webhooks/loopmessage` *(path stable per environment; exact string is implementation-defined)*

- **Why:** Inbound iMessage events from LoopMessage.
- **Auth:** LoopMessage request signing over the **raw body** per [LoopMessage API documentation](https://docs.loopmessage.com/) (ADR §5, AIC-004). Exact header names and dedupe id field: **record in the LoopMessage platform adapter contract note** (VID-002) before production cutover; see §10.
- **Request:** Raw body preserved for verification; JSON parsed only after trust. Internal shape after adapter normalization is not part of this public contract.
- **Response:** **2xx** only after a **durable** idempotency record for the **provider event id** is **committed** in Postgres; response body minimal. **2xx means** dedupe recorded, not that LLM or outbound iMessage completed.
- **Errors:** **401/403** invalid signature; **400** malformed; **503** if dedupe committed but **Redis enqueue fails** (AIC-002).
- **Validation:** Raw body + signature first; then schema validation on parsed payload at adapter boundary (VID-001, VID-003).
- **Status:** Approved candidate (vendor wire details frozen via adapter note per §10).

---

### API-OTP-001 — `POST /utility/otp/request` *(prefix `/utility` may be adjusted; keep stable per env)*

- **Why:** Start export/delete verification; send OTP via LoopMessage (Q4.R2, ADR §9).
- **Auth:** **Cloudflare Turnstile** server-side verify; no end-user auth (SPC-001).
- **Request summary:** Recipient handle (typically **E.164** phone), Turnstile token, optional non-sensitive client metadata.
- **Response summary:** **200** with a **generic** success message that does **not** reveal whether the recipient exists (SPC-004).
- **Errors:** **400** validation or Turnstile failure; **429** when per-recipient OTP send cap exceeded (max **3** sends / recipient / hour, Q4.R4); **5xx** only for true server faults.
- **Validation:** Recipient format per §7; Turnstile token required and verified before any OTP send.
- **Status:** Approved candidate.

---

### API-OTP-002 — `POST /utility/otp/verify`

- **Why:** Establish a short-lived **verified rights token** for export/delete actions (Q4.R3, resolved intake §17).
- **Auth:** None beyond binding to the prior OTP request (opaque request id or server-issued token from the OTP request flow—implementation detail, see §8).
- **Request summary:** OTP code plus binding to the prior request (request id or continuation token).
- **Response summary:** **200** with **opaque bearer token** (and optional expiry hint for UX only; server enforces TTL).
- **Errors:** **400** malformed input; **401/403** wrong or expired code; after **5** failed attempts for the **same issued code**, invalidate that code (Q4.R4).
- **Validation:** OTP **15-minute** default validity (Q4.R4).
- **Status:** Approved candidate.

---

### API-RIGHTS-001 — `POST /utility/rights/export`

- **Why:** Enqueue automated export after verification (Q4.R5, ADR §14).
- **Auth:** **`Authorization: Bearer <verifiedRightsToken>`** from API-OTP-002 (see §8).
- **Request summary:** Bearer token only, plus optional non-PII client metadata if needed.
- **Response summary:** **202 Accepted** with a reference id for support/diagnostics.
- **Errors:** **401** missing/invalid/expired token; **5xx** if job enqueue fails. **409** for duplicate in-flight export: **deferred** unless product requires it.
- **Validation:** Token scope must include **export** for the bound recipient only.
- **Status:** Approved candidate.

---

### API-RIGHTS-002 — `POST /utility/rights/delete`

- **Why:** Enqueue automated account deletion after verification (Q10.R1, ADR §14).
- **Auth:** Same bearer token pattern as API-RIGHTS-001; token scope must include **delete** for the bound recipient only.
- **Request summary:** Bearer token.
- **Response summary:** **202 Accepted** with reference id.
- **Errors:** **401** unauthenticated; **5xx** on enqueue failure.
- **Validation:** Same as export for token binding.
- **Status:** Approved candidate.

**Intentionally not defined as public HTTP contracts:** Outbound LoopMessage send (worker/adapter internal); LLM calls; presigned S3 GET (S3/AWS-facing); admin/operator APIs (Q2.3, Q9.1).

---

## 5. Webhook Contract Catalog

### WH-LM-001 — LoopMessage inbound webhook

- **Purpose:** Deliver inbound iMessage events to the monolith.
- **Source system:** LoopMessage.
- **Signature / auth:** Per [LoopMessage API documentation](https://docs.loopmessage.com/) (HMAC/signature over raw body unless docs specify otherwise, ADR §5). **Implementation must copy exact headers, algorithms, and any timestamp/replay rules from current docs into the platform adapter contract note** (VID-002) before production.
- **Payload summary:** Vendor JSON; one **stable provider event id** used for deduplication (field name/path per vendor docs).
- **Idempotency / retry:** Provider retries on non-2xx; server **must** dedupe by provider event id before side effects. Duplicate deliveries after **2xx** must not double-enqueue duplicate work (Postgres idempotency row).
- **Response / acknowledgement:** **2xx** only after Postgres idempotency commit; **503** if enqueue fails after commit (AIC-002).
- **Status:** Approved candidate (wire specifics frozen in adapter note per §10).

No other MVP inbound webhooks.

---

## 6. Internal Event Contract Catalog

MVP async spine is **BullMQ** in **one worker** deployment (FPC-002). These are **job contracts**, not public HTTP. Payloads are **adapter-normalized** where they originated from LoopMessage.

### JOB-INBOUND-001 — Inbound pipeline continuation

- **Producer:** API after WH-LM-001 dedupe + enqueue.
- **Consumer:** Worker.
- **Payload summary:** Correlation id, internal recipient ref, normalized inbound content references, dedupe keys (exact fields in implementation schema—not the full data model).
- **Delivery / retry:** Bounded retries, DLQ / failed-job path (ADR §1, AIC-003).
- **Idempotency:** Outbound sends use idempotency keys; LLM steps tolerate retries with stable keys where feasible.
- **Status:** Approved candidate.

### JOB-SCHED-001 — Due check-in dispatch

- **Producer:** Scheduler (BullMQ repeatable / delayed jobs).
- **Consumer:** Worker.
- **Payload summary:** Recipient ref, scheduled window identifier, correlation id.
- **Delivery / retry:** Same as JOB-INBOUND-001.
- **Idempotency:** Send idempotency for proactive class messages.
- **Status:** Approved candidate.

### JOB-EXPORT-001 — Export bundle build + delivery notification

- **Producer:** API after API-RIGHTS-001 accepts request.
- **Consumer:** Worker.
- **Payload summary:** Recipient ref, verification reference, SLA inputs (three US business days, `America/New_York`, per ADR §14).
- **Delivery / retry:** Same retry/DLQ policy.
- **Idempotency:** No duplicate user-visible export bundles from a single verified intent—use idempotent S3 key strategy or phase flags (implementation detail).
- **Status:** Approved candidate.

### JOB-DELETE-001 — Account deletion execution

- **Producer:** API after API-RIGHTS-002 accepts request.
- **Consumer:** Worker.
- **Payload summary:** Recipient ref, flags for cancellation scope (pending jobs, S3 objects, etc.—orchestration detail, not full schema here).
- **Delivery / retry:** Same retry/DLQ policy.
- **Idempotency:** Deletion safe under retry (tombstone / idempotent phases).
- **Status:** Approved candidate.

### JOB-MAINT-001 — Abandonment / purge / housekeeping

- **Producer:** Repeatable scheduled jobs (same worker).
- **Consumer:** Worker.
- **Payload summary:** Rule identifier (e.g. 7-day outbound stop, 90-day pre-goal purge per clarifications).
- **Delivery / retry:** Same family of policies; noop when rule already applied.
- **Idempotency:** Skip-noop when state already matches target.
- **Status:** Approved candidate.

**Not used:** Cross-service event buses; transactional outbox publication events (MVP).

---

## 7. Validation and Schema Conventions

- **Required vs optional:** List required fields explicitly per contract when adding JSON Schema; missing required → **400**. Prefer **omit** optional fields over sending `null` for utility JSON (single consistent style).
- **Formats:** Utility **recipient** default path: **E.164** for phone. If product adds Apple ID email, validate as bounded string per LoopMessage adapter agreement.
- **Enums:** Closed enums for small fixed sets; unknown values → **400**.
- **Size limits:** Enforce max body size at Fastify; cap string lengths at boundary (numeric constants live in code/config, not in this doc).
- **Unknown fields:** **Reject** on utility JSON. Webhook: parse vendor JSON in adapter only; **strip or map** unknown vendor fields; do not pass raw vendor blobs into domain (VID-003).
- **Content-Type:** `application/json; charset=utf-8` for JSON endpoints; reject wrong types.

---

## 8. Auth and Error Conventions

**Authentication**

- **LoopMessage webhook:** Signature verification only (not end-user identity).
- **Utility HTTP:** Turnstile on **API-OTP-001**; **verified rights** via **opaque bearer token** issued by **API-OTP-002**. Clients send **`Authorization: Bearer <token>`**. CORS allowlisted origins; **no cookies** for MVP utility session (simplest cross-origin story with Vercel → Render).
- **Health / readiness:** No user identity; public GETs as in §4.

**Authorization (contract level)**

- Bearer token is bound to **one recipient** and **scoped capabilities** (e.g. `export`, `delete`—exact claim shape in implementation). Rights endpoints must not operate on any other recipient (DDC-003).

**Error envelope (JSON)**

- Fields: `error.code` (machine-readable string), `error.message` (safe, non-enumerating), `requestId` (correlation). Optional `details[]` for field-level validation **without** sensitive data.
- Do **not** log or return: full message bodies, OTPs, presigned URLs, raw webhook bodies (OAC-002, Q10.3).

**HTTP status consistency**

- **400** validation; **401/403** auth/session; **429** documented rate limits; **503** transient/deps including webhook enqueue failure after dedupe commit; **202** async acceptance for rights actions.

---

## 9. Deferred / Not-in-Scope Contracts

- Per-**IP** OTP request limits (post-MVP, ADR §14).
- Postgres **outbox** for webhook enqueue (explicit non-MVP, ADR §1).
- Admin/support APIs, analytics ingestion, billing webhooks.
- OTP verification **via iMessage reply** (out per [resolved-architecture-intake.md §17](./resolved-architecture-intake.md)).
- Single-download gates for export URLs—**standard presigned GET**, multiple downloads until TTL expiry (resolved intake §17).
- Public end-user feature-flag API (ADR §8).
- Microservices, extra worker deployments, non-iMessage channels.

---

## 10. Open Items

1. **LoopMessage wire spec in repo:** Before production, add a **code-adjacent contract note** (VID-002) listing exact signature header(s), algorithm, raw-body encoding rules, JSON path for provider event id, and any replay/timestamp window—copied from current [LoopMessage docs](https://docs.loopmessage.com/). Until that note exists, treat WH-LM-001 as **approved process**, not **frozen field names**.
2. **Export vs delete token scope:** Whether one combined “rights” token covers both actions or separate tokens/scopes—product/security choice during implementation (document in the same bearer-token issuance logic).

---

## 11. Draft Approval Summary

This document defines the **minimum** HTTP surface (health, readiness, LoopMessage webhook, OTP request/verify, export/delete enqueue), the **LoopMessage webhook trust and ACK semantics**, and **BullMQ job boundaries** aligned with ADR-001 and implementation constraints. It does **not** define the full data model, persistence ownership, or implementation sequencing. **Bearer-based** utility auth and **public** readiness are **pinned** for MVP; LoopMessage **field-level** wire details are **pinned via the adapter contract note** (§10) at integration time.

---

## 12. Proposed filename

This file: **`docs/contracts-first-mvp-backend.md`**

Alternative if renaming later: `docs/mvp-backend-contracts-first-design.md`.
