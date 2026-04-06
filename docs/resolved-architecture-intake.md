# Resolved Architecture Intake

**Product:** AI Accountability Companion (iMessage via LoopMessage)  
**Source of truth:** [clarification-answers.md](./clarification-answers.md) (March 2026, rounds 3–4)  
**Stack (MVP):** No Clerk · Supabase Postgres · S3 · modular monolith · **background worker(s)** for **all** durable async jobs (inbound pipeline, scheduled check-ins, export/delete, maintenance)—see §9–10 and [ADR 001](./adr-001-backend-mvp-architecture.md).

**Implementation workshop (March 2026):** [ADR 001](./adr-001-backend-mvp-architecture.md) **§14** pins **Render** (API + worker + Redis), **Vercel** (marketing + utility site), **OpenRouter** LLM gateway, **Turnstile**, **Sentry**, **LoopMessage non-prod guardrails**, **automated export/delete**, **3 US business days (ET) SLA** semantics, **v1 proactive defaults**; **no per-IP** limits on OTP *request* for MVP (Turnstile + **Q4.R4**).

---

## 1. Business Goal

- **Primary MVP success metric:** active daily conversations measured as **reply turns per day**.
- **Commercial model at launch:** **freemium** with limits on goals/check-ins; MVP uses **soft enforcement** only—persist **usage counters**, **warn in iMessage** near limits, and **do not hard-block** goals/check-ins until **numeric caps** are defined and **hard enforcement** is enabled via config/feature flag.
- **Geography / regulatory stance (v1):** **US-only** copy and planning assumptions.

---

## 2. User Types

- **End users only:** consumers interacting through **iMessage** (LoopMessage); single consumer product, one user pool.
- **No roles for MVP:** no in-product support/admin persona, **no** privileged operator UI or API to read threads or pause users.
- **Identity:** no Clerk and no third-party auth in MVP; the **canonical user key** is the **LoopMessage recipient** (typically phone **E.164** and/or iCloud email as used in LoopMessage `recipient`).

---

## 3. Tenant / Organization Model

- **Tenant model:** **single-tenant consumer app**—one application, one undifferentiated user pool; **no** multi-org B2B tenancy.
- **Onboarding gate:** user **must send the first message** (deep link onboarding per PRD) before **reliable outbound** iMessage; no browser “link to Clerk” or pre-auth linking step.

---

## 4. Core Workflows

- **Onboarding:** **full conversational onboarding in iMessage** before a goal exists; onboarding is **complete only when the first goal is persisted**.
- **Goals:** **one active goal per user at a time** (MVP).
- **Check-ins:** **scheduled proactive check-ins only after** onboarding is complete (goal exists).
- **User controls:** pause **all** check-ins; **per-goal** pause/snooze; **global quiet hours** (timezone collected **during iMessage onboarding**); **delete account and all associated data**.
- **Accountability / streaks:** only **affirmative intent** (“yes/done”) established via **NLU** counts toward accountability/streaks.
- **Pre-goal abandonment:** if **no goal** within **7 days** of **first inbound**, **stop automated outbound** to that recipient (inbound may still be received and stored) until they message again.
- **Long-term pre-goal purge:** **purge** recipient and associated app data after **90 days** with **no goal** and **no inbound activity** (activity = any inbound message; implementation may refine).

---

## 5. Inputs into the System

- **Inbound messaging:** **iMessage only**, via **LoopMessage webhooks**—text and **inbound images** in the product flow; images are handled **transiently** toward the LLM (**not** persisted to S3).
- **Web:** **marketing/landing**, **deep link**, and **utility forms** for **export** and **delete** verification—**no** full logged-in consumer web dashboard.
- **Export/delete verification (request):** landing form collects **iMessage reachability** (recipient id, typically phone E.164); system sends **OTP via LoopMessage** (**no email**). **Existing threads only:** recipient must already be a known contact (has sent first message to Sender Name); unknown recipients **rejected** without user enumeration. Landing OTP endpoint: **Cloudflare Turnstile** (server-side verify) + **Q4.R4** per-recipient send caps; **MVP:** **no per-IP** rate layer on this route ([ADR 001](./adr-001-backend-mvp-architecture.md) **§14**).
- **Export/delete verification (confirm):** user enters OTP on the **marketing site** (session or opaque request token); **MVP may optionally** accept OTP by **reply in iMessage** (not required to be the only path).
- **Webhook processing:** **idempotency** using **LoopMessage (provider) event id** for deduplication.

---

## 6. Outputs from the System

- **User-facing delivery:** **iMessage only** for conversational and proactive messages (**no** push, email, or SMS outside iMessage for MVP).
- **Export fulfillment:** after verified OTP, produce export bundle to **S3**; user receives **iMessage** with **short-lived HTTPS** access (presigned or equivalent **single-use/tokenized** download), **default TTL 24 hours** from send.
- **Export bundle scope (Q6.R2):** **message history** (text + timestamps) + **active goal config** + **scheduler fields** (schedule + quiet-hours inputs). **Exclude** extra derived internals unless the product expands export later.
- **Delete fulfillment:** after verified OTP, execute deletion per agreed application scope within **72 business hours** SLA as implemented: **three (3) US business days** in **`America/New_York`** (Mon–Fri), deadline **23:59:59 ET** on the third business day—public copy should say **“within 3 business days.”** **Default path:** **fully automated** worker fulfillment after verification; **manual** steps only on failure/DLQ (see [ADR 001](./adr-001-backend-mvp-architecture.md) **§14**).
- **Reliability:** outbound sends target **at-least-once** with **retries** and **idempotency keys**; on LoopMessage or LLM failure, **static fallback** to the user where appropriate **plus** retry/queue behavior.

---

## 7. External Integrations

- **LoopMessage:** **single production project**; development uses the **same** project with **tight limits** (accepted operational risk). **Workshop guardrails:** separate **Supabase + Redis + Render** per environment; **no prod LoopMessage credentials** in non-prod; **non-prod outbound iMessage** only to **allowlisted** test recipients (application-enforced). Plan enforcement: **hard caps / waitlist** when approaching vendor limits.
- **LLM:** **OpenRouter** (unified gateway; handles provider routing, model selection, and failover internally; primary + fallback model IDs configured via `OPENROUTER_PRIMARY_MODEL` / `OPENROUTER_FALLBACK_MODEL`). **Conditional guardrails:** **per-user daily token cap** and **global kill switch / degraded mode** during cost spikes or virality; **no standing cap** if virality does not materialize.
- **Public web:** **Vercel** hosts marketing + utility forms; browser calls **Fastify** on **Render** with **CORS** allowlisting.
- **Observability:** **Sentry** for API + worker (staging/production), scrubbed per Q10.3.
- **Object storage:** **AWS S3** per environment (**one bucket per env**) with **separate key prefixes**: **user export bundles** and similar user-facing download artifacts; **operational database backup artifacts** produced by CI (not user data files). **Not** used for inbound images or primary message bodies (**Q6.3**). Least-privilege IAM per workload/prefix.
- **Analytics / attribution:** **none** in MVP (no product analytics pipeline).

---

## 8. Core Data Entities

Backend-oriented entities implied by clarifications (names are logical, not schema prescriptions):

- **Recipient / user** — LoopMessage recipient identifier, onboarding state, quiet-hours timezone, pause/snooze flags, freemium **usage counters**, linkage to “first message” / known-contact eligibility.
- **Goal** — active goal record with **at most one active** per recipient in MVP; per-goal pause/snooze.
- **Message** — inbound/outbound text, timestamps; **retain until account deletion**; **no** durable storage of inbound attachment bytes on S3.
- **Scheduler / check-in state** — persisted **schedule inputs** (timezone, quiet hours, cadence) plus a **derived next-run** (or equivalent) recomputed on change; **missed windows** (e.g. downtime) are **marked as missed**; streak / accountability logic **accounts for missed windows** (Q12.3).
- **NLU outcomes / accountability state** — **structured intent from the primary LLM response** (e.g. done vs not done) per architecture ADR—not a separate NLU service for MVP.
- **OTP / verification session** — issued codes, attempts, expiry (**15 min** default), send-rate limits (**3 sends per recipient per hour**), failed-attempt cap (**5** then invalidate).
- **Webhook idempotency** — store keyed by **provider event id**.
- **Export job / artifact metadata** — ties export bundles in **S3** to recipient; supports **72 business hour** SLA and presigned delivery; artifact contents follow **Q6.R2** (see §6).
- **Outbound send jobs / queue state** — supports retries, idempotency keys, and **cancellation** on account deletion.

---

## 9. Sync Actions

- **HTTP webhook handler:** **hybrid pattern** — after signature verification, **persist idempotency** for the **provider event id** in Postgres (**commit before HTTP 2xx**); then **enqueue** downstream work to Redis. **2xx means** dedupe is durable, **not** that LLM/outbound completed. If **enqueue fails** after commit, return **non-2xx** (e.g. 503) so the provider **retries** safely.
- **Marketing and deep-link surfaces:** static/SSR responses as appropriate.
- **Landing OTP request:** validate input, **Turnstile** verify + **known recipient only** + **Q4.R4** send limits, enqueue or trigger LoopMessage OTP send, return safe response **without** enumeration (**no per-IP** limits for MVP per ADR **§14**).
- **Landing OTP verify:** validate code, attempts, and session/token; establish short-lived **verified session** for export/delete actions.

---

## 10. Async Actions

- **Inbound message pipeline:** LLM inference, NLU (structured intent on primary LLM path), conversation state updates, and **outbound iMessage** composition/send after webhook ACK (LLM latency).
- **Background worker:** **one worker runtime** processes **all** queued job types (inbound continuation, **scheduled check-ins**, export/delete, abandonment/purge)—not a worker limited to check-ins only.
- **Scheduler misses / downtime (Q12.3):** when a due window is not processed in time, **mark that window as missed** (do not pretend the check-in was sent); **streak and accountability logic** must **account for missed windows** consistently.
- **Retries:** at-least-once outbound processing with **idempotency keys** and retry policy.
- **Export bundle generation** and **account deletion execution** after OTP verification, within **SLA** above—**automated** worker jobs as default; operator/runbook only for **exception** paths.
- **Abandonment and purge:** time-based jobs to stop outbound (7-day rule) and purge stale pre-goal recipients (90-day rule).

---

## 11. Notification Requirements

- **Channels:** **iMessage only**; **no** non-iMessage notifications in MVP.
- **Proactive policy:** **global caps** on proactive iMessage volume **and** **adaptive throttling** when reply rate drops (sender reputation protection). **MVP:** enforcement is **config-backed** with **v1 numeric defaults** in [ADR 001](./adr-001-backend-mvp-architecture.md) **§13** (8/user/24h rolling, 90m min spacing, 7d / below-30% reply rate → 1.5× backoff, 48h cap; proactive excludes immediate inbound replies).
- **Freemium (soft):** **in-iMessage warnings** as users approach limits (no hard block until caps and flag are defined).

---

## 12. Security / PII / Compliance

- **Sensitivity:** positioned as **light / general wellness**; **not** optimized for minors or under-13 / COPPA workflows in v1.
- **PII / content:** recipient identifiers and **message content** in **Supabase** as designed; **application logs redacted**—**no full message bodies** in app logs.
- **User rights path:** web OTP verification then export/delete fulfillment; **email not required**.
- **OTP defaults:** **15-minute** validity; **max 5** failed verifications per issued code then invalidate; **max 3** OTP **sends** per recipient per **hour**.
- **Deletion (application scope):** remove Supabase rows for that user/recipient (messages, goals, profile, scheduler, OTP sessions, usage counters, etc.), delete **user-owned S3 objects** (including prior export bundles), **cancel** pending worker/scheduled sends. **Honesty:** cannot guarantee erasure on **LoopMessage** or other vendors beyond their APIs/terms; **backups** and **infra logs** follow retention and minimization policy aligned with Q10.3.

---

## 13. Expected MVP Load

- **Planning band:** LoopMessage **Light–class** envelope—on the order of **~300 contacts/day** and **~1k contacts/month** (per PRD reference in clarifications).
- **Vendor limits:** **hard caps / waitlist** when approaching LoopMessage plan limits.
- **LLM cost:** conditional **per-user daily token cap** and **global kill switch / degraded mode** when needed; otherwise no standing global cap absent virality-driven cost pressure.

---

## 14. Non-Negotiables

- **Identity:** **no Clerk** and **no third-party auth** in MVP; **LoopMessage recipient** is canonical.
- **Datastores:** **Supabase Postgres** for primary app data; **S3** for **(1)** user export/download artifacts and **(2)** operational DB backup dumps (CI), using **distinct prefixes** in a per-environment bucket—not for inbound media or chat storage (**Q6.3**).
- **Architecture:** **modular monolith** for the main API surface; **dedicated worker/queue process** for **all** durable background jobs (inbound pipeline, scheduled check-ins, export/delete, maintenance—not check-ins only).
- **Messaging boundary:** **iMessage via LoopMessage** as the sole user messaging channel; web is **marketing + utilities** only.
- **Webhook pattern:** **hybrid** (fast ACK + async continuation); **mandatory webhook idempotency** via **provider event id**.
- **Scheduler accountability:** **missed windows are recorded as missed**; streak / NLU-based accountability **handles misses** without contradicting Q12.3.
- **Product rules:** **one active goal** per user; **no** admin/support console or privileged MVP APIs for operators.
- **Operational reality:** ops via **database + logs** + **Sentry**; **export/delete** default is **automated** (manual only on failures). **No** structured human review queue for AI content in MVP.

---

## 15. Remaining Assumptions

- **“Inbound activity”** for the 90-day purge is **any inbound message** unless implementation tightens the definition.
- **Export/delete SLA** is implemented as **3 US business days (ET)** per workshop; **federal holidays** not excluded in v1 unless added later.
- **Deep link onboarding** details (exact URLs and Sender Name behavior) remain as specified in PRD v3.0; they were not re-listed in the clarification tables beyond “first message” gating.

---

## 16. Remaining Open Questions

- **Freemium numeric caps:** values for goals/check-ins limits and timing to switch from **soft** to **hard** enforcement (config/feature flag).
- **Delete confirmation UX:** optional **iMessage** confirmation when deletion completes (nice-to-have only).
- **LLM integration tuning:** exact models, temperatures, router thresholds—set during implementation (OpenAI primary / Anthropic fallback per ADR).
- **Optional later tuning:** OTP/link TTLs (defaults already in clarifications), proactive thresholds, LLM token-cap trigger levels—may change with ops feedback.

**LoopMessage webhook** signing, stable **event id** for dedupe, and replay/timestamp handling: **follow LoopMessage docs at integration time**—not a separate open architecture question ([ADR 001](./adr-001-backend-mvp-architecture.md) **§5**, **§14**).

---

## 17. MVP implementation forks (delivery planning, March 2026)

Recorded **after** ADR acceptance; **do not** amend ADR 001 for these—they refine product/build scope only.

- **Export / delete OTP (MVP):** OTP is **delivered via iMessage (LoopMessage)** and **entered only on the marketing site**; **no** “reply with the code in iMessage” verification path in MVP.
- **Freemium soft warnings:** Until **numeric caps** are defined, use **config placeholder thresholds** to drive **warning-only** iMessage copy; **hard enforcement** stays off until product enables it (still aligns with **Q1.R1**).
- **Export download link:** **Standard presigned GET** to the bundle in S3; **multiple downloads allowed** until the link **expires** (default TTL remains per **Q4.R6** / ADR **§7**); **no** one-time / single-download gate in MVP.
