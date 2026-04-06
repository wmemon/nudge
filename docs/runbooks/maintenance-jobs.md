# Runbook — Maintenance Jobs (MAINTENANCE queue)

Two recurring jobs run daily on the MAINTENANCE queue. They handle recipients who
signed up but never set a goal — enforcing the 7-day outbound stop and the 90-day
data purge (Q3.R3, resolved-architecture-intake §15).

---

## Jobs

### `7-day-stop` — Enforce outbound stop

**What it does:** Finds recipients who have been in the system for more than 7 days
without completing onboarding (`onboarding_complete = false`) and whose outbound
messages are not yet paused. Sets `globally_paused = true` on each, so no further
automated check-ins are sent to them. The recipient can still send inbound messages
at any time; auto-resume is planned post-MVP.

**Schedule:** Daily at **02:00 UTC** (`0 2 * * *`)

**Batch size:** Up to 200 recipients per run. Large backlogs drain over multiple days.

---

### `90-day-purge` — Enqueue pre-goal data deletion

**What it does:** Finds recipients who have been in the system for more than 90 days
without setting a goal _and_ have not sent any inbound message in the last 90 days.
For each, it enqueues a standard `JOB-DELETE-001` job on the DELETE_FULFILLMENT queue
with `jobId = delete:{recipientId}`. This is the same delete job used for user-rights
deletions — idempotent by design (AIC-003).

**Schedule:** Daily at **02:30 UTC** (`30 2 * * *`)

**Batch size:** Up to 200 candidates per run.

---

## Confirming jobs are registered

Repeatable jobs are registered at worker boot inside `scheduleMaintenanceJobs()`.
They are idempotent — calling it on restart does not create duplicates.

Check registered repeatable jobs via Redis CLI:

```bash
redis-cli ZRANGE "bull:maintenance:repeat" 0 -1 WITHSCORES
```

Or via the BullMQ Admin UI if configured — look for entries named `7-day-stop` and
`90-day-purge` under the `maintenance` queue.

---

## What to do if a job is not firing

1. **Check Redis connectivity** — the worker will log a `redis.ping.ok` event at
   startup. If it's absent, Redis is unreachable.

2. **Confirm `scheduleMaintenanceJobs` ran** — look for the
   `maintenance.scheduled` log event with `jobs: ["7-day-stop", "90-day-purge"]`.
   If absent, the worker may have crashed before reaching that step.

3. **Re-register by redeploying** — restarting the worker re-runs
   `scheduleMaintenanceJobs()` safely. No data is lost.

---

## Manually triggering a one-shot run

Use the BullMQ admin CLI or a Node.js script to add a one-shot job (no `repeat`
option) to the `maintenance` queue:

```ts
import { getQueue, QUEUE_NAMES } from './src/platform/queue-bullmq/queues.js'

await getQueue(QUEUE_NAMES.MAINTENANCE).add('7-day-stop-manual', { type: '7-day-stop' })
await getQueue(QUEUE_NAMES.MAINTENANCE).add('90-day-purge-manual', { type: '90-day-purge' })
```

The handler dispatches on `job.data.type`, so the job name is for logging only.

---

## Usage warning thresholds

The usage counters (`goals_set`, `checkins_completed`) emit a `usage.goal_warn` or
`usage.checkin_warn` log event when a recipient's count reaches a configured
threshold. In MVP the thresholds default to **9999** (effectively never fires).

| Env var                       | Default | Effect                                      |
|-------------------------------|---------|---------------------------------------------|
| `USAGE_GOAL_WARN_THRESHOLD`    | 9999    | Warn when a recipient has set this many goals |
| `USAGE_CHECKIN_WARN_THRESHOLD` | 9999    | Warn when a recipient has had this many check-ins |

Hard enforcement is not implemented in MVP (Q1.R1).

---

## Log events to watch

| Event                              | Meaning                                                        |
|------------------------------------|----------------------------------------------------------------|
| `maintenance.scheduled`            | Repeatable jobs registered at boot — expected on every start   |
| `job.started` (jobType: 7-day-stop) | 7-day stop batch starting                                     |
| `abandonment.outbound_stopped`     | One recipient successfully paused                              |
| `abandonment.stop_failed`          | One recipient failed to pause — batch continues                |
| `abandonment.stop_run_complete`    | Batch finished — check `paused` and `failed` counts            |
| `job.started` (jobType: 90-day-purge) | 90-day purge batch starting                                |
| `abandonment.purge_enqueued`       | One recipient's delete job enqueued                            |
| `abandonment.purge_enqueue_failed` | One enqueue failed — will retry on tomorrow's run              |
| `abandonment.purge_run_complete`   | Batch finished — check `enqueued` and `failed` counts          |
| `usage.goal_warn`                  | A recipient hit the goal warn threshold                        |
| `usage.checkin_warn`               | A recipient hit the check-in warn threshold                    |
| `job.unknown_type`                 | MAINTENANCE job arrived with an unrecognised `type` field      |
