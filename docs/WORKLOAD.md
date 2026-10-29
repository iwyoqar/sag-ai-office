# Workload indicator (human employees)

An **operational workload-risk indicator**, not a medical or performance judgement. It never restricts,
deactivates or penalises anyone. Code: `apps/server/src/domain/workload.ts`. Policy is editable by holders of
`workload:configure` (director, admin) in *Xodimlar → Yuklama sozlamasi* (`PUT /api/settings/workload`).

## What counts

- The person's human tasks in `ASSIGNED`, `ACCEPTED`, `IN_PROGRESS`, `CHANGES_REQUESTED`, `BLOCKED`.
- Not counted: `DONE`, `CANCELLED`, `BACKLOG` (unassigned/declined) and `IN_REVIEW` (handed over; the reviewer acts next).
- A task that still has open subtasks is skipped — its subtasks carry the work, so nothing is counted twice.

## Formula

```
remaining  = estimate × (1 − progress%)          (and ≤ estimate − actual hours when actual hours are known)
           = defaultHours[priority] × (1 − progress%)   if there is no estimate → confidence "low"
factor     = 1                      deadline within the horizon (or overdue)
           = horizon ÷ time left    deadline later than the horizon (pro rata)
           = noDeadlineFactor       no deadline
           × blockedFactor          when the task is BLOCKED
demand     = Σ remaining × factor
capacity   = capacityHoursWeek ÷ 5 × horizonDays
percent    = demand ÷ capacity
```

## Levels (defaults)

| Level | Condition |
|---|---|
| GREEN | percent < 60 |
| YELLOW | 60 ≤ percent < 80, or at least one deadline within 24 h |
| ORANGE | 80 ≤ percent < 100, or ≥ 3 deadlines within 24 h, or 1 overdue task |
| RED — "OVERLOADED" | percent ≥ 100, or ≥ 2 overdue tasks |

Defaults: horizon 5 working days; default hours LOW 2 / MEDIUM 4 / HIGH 8 / URGENT 8; no-deadline factor 0.5;
blocked factor 0.25. Every result carries a one-line summary and the reasons behind it (shown when the badge is opened).

## When it is recalculated

On every read (always current). After each assignment, reassignment, start, progress update, submission, review,
block/unblock, cancellation and estimate/deadline change the level is re-evaluated; rising to ORANGE or RED sends one
in-app notification to the person and their manager per level per day (idempotent).
