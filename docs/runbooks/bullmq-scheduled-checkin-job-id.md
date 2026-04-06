# Scheduled check-in BullMQ `jobId` (colon rule)

## Symptom

Worker logs during goal capture:

```text
Error: Custom Id cannot contain :
    at Job.validateOptions (.../bullmq/.../job.js)
```

Inbound continuation job fails after `goal.captured` when enqueueing the delayed check-in job.

## Cause

BullMQ validates custom `jobId` values: if the id contains `:` it **must** split into **exactly three** segments when split on `:` (legacy repeatable-job compatibility).

We used:

`checkin:<recipientUuid>:<ISO-8601 instant>`

ISO strings look like `2026-04-07T21:00:00.000Z`. The colons inside the time (`21:00:00`) add **extra** segments, so the split is no longer exactly three → BullMQ throws **"Custom Id cannot contain :"** and **no delayed job is stored in Redis**.

## Fix

Use a third segment **without** colons. The implementation uses **Unix time in milliseconds** (digits only):

`checkin:<recipientUuid>:<runAt.getTime()>`

The same string must be used when **enqueueing** (`scheduleNextCheckin`) and when **removing** a pending job on account delete (`user-rights-ops`), so cancellation still matches.

## Operational note

If a recipient captured a goal while this bug was live, `next_run_at` may exist in Postgres but **no** BullMQ job was enqueued. After deploy, re-arm using **the same Supabase + Redis** as the worker.

**Render Shell** (worker service): environment variables are **injected** — there is no `.env` file. Use:

```bash
pnpm ops:arm-schedule -- <recipient-uuid>
```

**Local machine** (with a `.env` file):

```bash
pnpm ops:arm-schedule:local -- <recipient-uuid>
```

**Where to run it:** The process must reach **the same Redis** the worker uses. Render’s `REDIS_URL` often uses an **internal hostname** that only resolves **inside Render**. If you see `getaddrinfo ENOTFOUND` for a `red-…` host from your laptop, use **Render Shell** (or a public Redis URL for dev only).

Sending a new iMessage **does not** call `scheduleNextCheckin` when a goal already exists (inbound path only enqueues via `captureGoal` on first goal capture).

## References

- BullMQ `Job.validateOptions` — `node_modules/bullmq/dist/cjs/classes/job.js` (custom id colon / segment check).
