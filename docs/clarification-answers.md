# Clarification Gate — Recorded Answers

**Product:** AI Accountability Companion (iMessage via LoopMessage)  
**Stack (MVP):** **No Clerk (round 3)** · Supabase Postgres · S3 · modular monolith · worker only if async clearly needed  
**Source:** PRD v3.0 + clarification sessions  
**Date:** March 2026 · **Rounds 3–4** recorded in this revision

**Note:** Workspace stack lock previously listed **Auth = Clerk**; **product decision (round 3) removes Clerk** for MVP. Canonical identity = **LoopMessage recipient** + app-owned data in Postgres. **Repo alignment:** [.cursor/rules/00-dreamlaunch-stack-lock.mdc](../.cursor/rules/00-dreamlaunch-stack-lock.mdc) now reflects **no Clerk** for this product.

---

## 1. Business goal

| # | Topic | Answer |
|---|--------|--------|
| Q1.1 | Primary success metric (MVP) | **A** — Active daily conversations (reply turns per day) |
| Q1.2 | Commercial model at launch | **B** — Freemium (limits on goals/check-ins) |
| Q1.3 | Geographic / regulatory stance (v1) | **A** — US-only copy and assumptions |
| Q1.R1 | Freemium enforcement (round 4) | **Soft MVP** — Store **usage counters** needed for limits; **warn in iMessage** when approaching limits; **no hard block** of goals/check-ins until product defines **numeric caps** and turns on **hard enforcement** (config/feature flag). |

---

## 2. Users / tenant model / permissions

| # | Topic | Answer |
|---|--------|--------|
| Q2.1 | Tenant model | **A** — Single consumer product (one app, one user pool) |
| Q2.2 | Identity / auth (round 3) | **No Clerk, no third-party auth MVP** — **Canonical user key** = **LoopMessage recipient** (phone E.164 and/or iCloud email as used with LoopMessage `recipient`). User **must send first message** (deep link onboarding) per PRD before outbound iMessage is reliable. |
| Q2.3 | Roles | **None** — **No** in-product support/admin role for MVP: **no** privileged operator UI/API to read threads or pause users. |

**Note:** There is **no** “pre-Clerk” or browser **link-to-Clerk** step; linking tables in older rounds are **obsolete**.

---

## 3. Core workflows

| # | Topic | Answer |
|---|--------|--------|
| Q3.1 | Goal model (MVP) | **One active goal per user at a time** (follow-up; supersedes “smart engine only” ambiguity) |
| Q3.2 | User controls | **A + B + C + D** — Pause all check-ins; per-goal pause/snooze; global quiet hours; delete account and all data |
| Q3.3 | What counts for accountability / streaks | **B** — Only affirmative intent (“yes/done”) via NLU counts |
| Q3.R1 | Quiet hours timezone | **A** — Collected during **onboarding in iMessage** |
| Q3.R2 | Onboarding complete (round 3) | **Goal captured** — Onboarding is **not** complete until the user’s **first goal** is persisted (see Q3.1). |
| Q3.R3 | Pre-goal threads & abandonment (round 3; prior gate **Q-A → A**, adapted) | **Full conversational onboarding** in iMessage **before** a goal exists. **Scheduled proactive check-ins** run **only after** onboarding is complete (goal exists). If **no goal** **7 days** after **first inbound**, **stop automated outbound** to that recipient (inbound may still be received/logged) until they message again. **Abandoned pre-goal contacts:** **purge** recipient and associated app data after **90 days** with **no goal** and **no inbound activity** *(“activity” = any inbound message; tune in implementation if needed)*. |
| Q3.R4 | Schedule defaults (implementation) | When the LLM fails to extract a valid check-in time during onboarding (e.g. structured output returns a malformed value), the system falls back to **`09:00` local time** in the user's detected timezone. Quiet hours default to **22:00–08:00 local**. Cadence defaults to **daily**. These are implementation fallbacks only — the LLM always asks the user for their preferred time; hitting these defaults means something went wrong with structured output extraction. Product may tune the `09:00` default via config if needed. |

---

## 4. Inputs and outputs

| # | Topic | Answer |
|---|--------|--------|
| Q4.1 | Inbound channels (MVP) | **A** — iMessage via LoopMessage only |
| Q4.2 | Outbound (MVP) | **A** — iMessage only |
| Q4.3 | Web surface (MVP) | **Marketing/landing + deep link** **+** **utility form(s)** for **export / delete verification** (see **Q4.R2–Q4.R6**). **No** full logged-in consumer web dashboard. |
| Q4.R2 | Export / delete verification — request code (round 3) | **Landing form + iMessage OTP** — User enters **iMessage reachability** (recipient id, typically **phone E.164**). System sends **OTP via LoopMessage** to that address. **No email** in this flow. **Eligibility (round 3):** **Existing threads only** — recipient must **already** be a known contact (they have **already sent the first message** to the Sender Name). Unknown numbers: **reject** safely (no user enumeration). **Abuse:** landing OTP endpoint requires **rate limits** and **bot friction** (CAPTCHA or equivalent) — implementation detail. |
| Q4.R3 | OTP confirmation channel (round 4) | **Landing page** — User enters the **same OTP** on the **marketing site** (verify step / second step), tied to the same browser session or **opaque request token**. **Not** required for MVP to accept OTP by **replying in iMessage**. |
| Q4.R4 | OTP parameters (round 4) | **Defaults:** OTP valid **15 minutes**; **max 5** failed verification attempts per issued code, then **invalidate**; **max 3** OTP **send** requests per recipient per **hour** (abuse). Product may tune later. |
| Q4.R5 | Export / delete fulfillment (round 3 + 4) | **After OTP verification**, **export** (bundle to **S3** per Q6.R1) and **account deletion** are fulfilled within **SLA:** **72 business hours** (round 3 **Q-E → B**). Generation may be **automated** or **operator-triggered**; export download follows **Q4.R6**. **Deletion** scope: **Q10.R1**. |
| Q4.R6 | Export artifact delivery (round 4) | **iMessage + time-limited HTTPS link** — User receives an **iMessage** to the verified thread with a **short-lived presigned URL** (or equivalent **single-use / tokenized** download) to fetch the bundle from **S3** (or app redirect to S3). **Default link TTL:** **24 hours** from send (tune if needed). |

---

## 5. Integrations

| # | Topic | Answer |
|---|--------|--------|
| Q5.1 | LoopMessage environments | **A** — Single production project; dev uses same with tight limits *(accepted operational risk)* |
| Q5.2 | LLM provider | **B** — Primary + fallback vendor for outages |
| Q5.3 | Analytics / attribution | **None for now** (follow-up; no product analytics pipeline in MVP) |

---

## 6. Data / records

| # | Topic | Answer |
|---|--------|--------|
| Q6.1 | Message retention | **D** — Store until user deletes account |
| Q6.2 | Media (MVP) | **Inbound images supported** — user wants inbound images present in the product flow |
| Q6.3 | Inbound images vs storage | **No S3 persistence for inbound media** — send image to the **LLM directly** / transient handling; **do not** store inbound attachments in S3 for MVP |
| Q6.R1 | S3 usage | **B** — **S3 used for user export bundles** (and similar user-generated download artifacts); inbound images **not** written to S3 (Q6.3) |
| Q6.R2 | Export bundle scope (round 3 **Q-D → A**) | **Core export:** message history (text + timestamps) + **active goal config** + **scheduler fields** (schedule + quiet-hours inputs). Exclude extra derived internals unless product expands later. |

---

## 7. Sync vs async behavior

| # | Topic | Answer |
|---|--------|--------|
| Q7.1 | Webhook handler pattern | **C** — Hybrid: quick acknowledgment + async continuation *(LLM may take time)* |
| Q7.2 | Scheduled check-ins | **B** — Separate worker/queue process for due jobs |
| Q7.3 | Outbound send reliability | **B** — At-least-once with retries and idempotency keys |

---

## 8. Notifications

| # | Topic | Answer |
|---|--------|--------|
| Q8.1 | Non-iMessage notifications (MVP) | **A** — None |
| Q8.2 | Proactive iMessage cadence policy | **B + C** — Global caps on proactive messages **and** adaptive throttling when reply rate drops (protect sender reputation) |

---

## 9. Admin / internal operations

| # | Topic | Answer |
|---|--------|--------|
| Q9.1 | Operational tooling | **A** — Database + logs only *(no full internal admin UI required by clarification)* |
| Q9.2 | Human review of AI content | **A** — No structured review pipeline *(automated only)* |

**Note:** Operational tooling = **engineering access** + **exception-only manual processes** (e.g. DLQ / failed jobs for export-delete per **implementation workshop**—default path is **automated** worker fulfillment after OTP verify). **Not** a customer support console.

**Note:** **MVP and beta** — no sampled manual AI review queue (earlier PRD beta sampling narrative **out of scope** unless revised).

---

## 10. Security / PII / compliance

| # | Topic | Answer |
|---|--------|--------|
| Q10.1 | Data sensitivity / audience | **Light / general wellness; no minors focus for now** (follow-up — not optimizing for under-13/COPPA workflows in v1) |
| Q10.2 | User rights baseline (round 3) | **Web OTP verification + fulfillment** — Flow: **Q4.R2** (request code) → **Q4.R3** (enter code on site) → verified session → **export**/**delete** per **Q4.R5**; export download via **Q4.R6**. **Email not required**. |
| Q10.3 | Logging of message content | **B** — Redacted logs; content only in primary datastore as designed (not full content in app logs) |
| Q10.R1 | Account deletion scope (round 4) | **In scope (application):** Delete **Supabase** data for that recipient/user (messages, goals, profile, scheduler state, OTP sessions, usage counters, etc.) and **S3 objects** belonging to that user (including prior export bundles). **Cancel** pending **worker** jobs / scheduled sends for that recipient. **Out of scope / vendor honesty:** Cannot guarantee erasure on **LoopMessage** or other third parties beyond their APIs/terms; **backups** and **infra logs** follow retention/minimization policy (no message bodies in app logs per **Q10.3**). |

---

## 11. Load / limits / scale

| # | Topic | Answer |
|---|--------|--------|
| Q11.1 | Scale expectations | **A** — Default planning band: **LoopMessage Light–class** envelope (PRD: ~300 contacts/day, ~1k contacts/month) |
| Q11.2 | LoopMessage plan enforcement | **B** — Hard caps / waitlist when near plan limits *(assistant recommendation accepted)* |
| Q11.3 | LLM budget guardrails | **Conditional:** enable **per-user daily token cap** + **global kill switch / degraded mode** during cost spikes or virality; **no standing cap** if virality does not hit |

---

## 12. Failure tolerance / retries / reliability

| # | Topic | Answer |
|---|--------|--------|
| Q12.1 | LoopMessage or LLM failure on inbound | **Assistant recommendation accepted:** static fallback to user where appropriate **plus** retry/queue behavior *(user: “Let’s do your recommendation”)* |
| Q12.2 | Webhook idempotency | **B** — Required; dedupe by LoopMessage (provider) event id |
| Q12.3 | Scheduler misses (downtime) | **C** — Mark window as missed; streak / accountability logic accounts for missed windows |

---

## Glossary (session)

- **NLU:** Natural language understanding — mapping free-text replies to structured intent (e.g., counts as “done” vs not).

---

## Backend implementation workshop (March 2026)

Pinned in [ADR 001](./adr-001-backend-mvp-architecture.md) **§14** and summarized in [resolved-architecture-intake.md](./resolved-architecture-intake.md) header. Resolutions:

| Topic | Choice |
|--------|--------|
| LLM gateway | **OpenRouter** (unified gateway; single `OPENROUTER_API_KEY`; primary + fallback model IDs configured via `OPENROUTER_PRIMARY_MODEL` / `OPENROUTER_FALLBACK_MODEL`) |
| Hosting (API + worker + Redis) | **Render** |
| Marketing + utility site | **Vercel** |
| Bot friction (OTP request) | **Cloudflare Turnstile** |
| Error tracking | **Sentry** (API + worker) |
| LoopMessage (Q5.1 + guardrails) | One project; **separate** Supabase/Redis/Render per env; **no prod LM creds** in non-prod; **allowlisted** outbound recipients in non-prod |
| Export / delete after OTP | **Fully automated** worker path; manual **runbook** for failures |
| SLA “72 business hours” | Implement as **3 US business days**, **`America/New_York`**, EOD third business day; copy: **“within 3 business days”** |
| Proactive throttle v1 defaults | Per ADR **§13** (8/user/24h, 90m spacing, 7d below-30% reply rate → 1.5× backoff, 48h cap; proactive excludes immediate replies) |
| OTP request per-IP limits | **Skipped for MVP** (Turnstile + Q4.R4 only); **post-MVP** if needed (ADR **§14**) |
| LoopMessage webhook details | **Integration only** — match current LoopMessage docs (signing, dedupe id, replay rules); no extra workshop lock (ADR **§5**, **§14**) |

---

## Open items for future revision

- **Freemium numeric caps (Q1.2):** Set when product is ready; flip **Q1.R1** from soft-only to **hard enforce** via config.
- **Delete confirmation UX:** Optional **iMessage** confirmation when deletion is complete (nice-to-have; not required for architecture).
