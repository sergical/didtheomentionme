# Story beat: Sentry caught an N+1 in the pipeline

For the video "Did Theo Read Your Tweet? I Made AI Watch His Videos" (DevEx idea `4acc7700`). This is the part where
Sentry's role shows: while I built the app, Sentry found a slow pattern in the pipeline that tests could not show.
These are the facts and the screens. The spoken lines are yours to write.

## What happened

Every 10 minutes a cron job reads the YouTube RSS feed of each creator's channels (Theo has 1 channel, Prime has 2).
Each feed lists about 15 recent videos. The job put each video into the database with its own query:

```ts
for (const entry of feed.entries) {
  await db.insert(entry); // one D1 round trip per video
}
```

That is an N+1: one query per item, where one query for all items does the same work. Each D1 query is a network
round trip from the Worker to the database, about 40 ms, so 15 videos cost about 600 ms for one feed. The job does this
144 times a day, and almost every video it inserts is already in the database.

## Why nothing showed it before Sentry

- **Tests:** they run D1 on an in-memory SQLite database, where a query takes microseconds, so 30 queries look free.
- **The cron's result:** it was correct. Only the time and the number of round trips were wrong, and nobody watches a
  cron job finish.
- **Sentry:** it sees each query as a span in the cron's trace. Its performance detector found the pattern on its own:
  Issue DIDTHEOMENTIONME-1, "Inefficient Database Queries", first seen on 2 November. Its explanation: "The 'discover
  prime' function executes 30 sequential INSERT statements into the 'videos' table. These individual queries should
  be batched into a single multi-row INSERT to reduce round-trip overhead."

## The fix

All of a feed's videos now go to D1 in one batch, one round trip per feed (`insertPending` in `src/videos.ts`).

| Cron run (production) | D1 queries | `discover prime` | `discover theo` | Whole cron |
|---|---|---|---|---|
| 21 Nov 20:30 UTC, before | 49 | 1,536 ms | 850 ms | 1,698 ms |
| 21 Nov 20:40 UTC, after | 10 | 762 ms | 368 ms | 919 ms |

Sources: Sentry traces `b25f8c880c8c4abe2e05ad818287776e` (before) and `70e8ec75ea677b324647b433af780bc8` (after), in
the `sergtech/didtheomentionme` project. The test `a feed's videos go into D1 in one batch, not one query each`
(`test/discovery.test.ts`) fails on the old code.

## A second lesson, if there is time

After I moved the app to Effect and OpenTelemetry, Sentry reported two more N+1s on `/explore` (DIDTHEOMENTIONME-7
and -9). They were not real. My new tracing named each D1 span with a short summary, so six different queries all
read "SELECT mentions videos", and Sentry took them for one query that ran six times. Sentry groups queries by the
span description, so the description must be the whole SQL. With that fixed, the alerts stopped. The point for
viewers: your instrumentation decides what Sentry can see.

The same scan also found a real one: a lookup waited for its search before it counted the creator's videos, though
the count needs nothing from the search (DIDTHEOMENTIONME-8 and -A, "Consecutive DB Queries"). They now run at once.

## Screens to record

1. The Issue DIDTHEOMENTIONME-1 in Sentry, with its explanation.
2. The before trace: the cron span with its column of `INSERT videos` spans under `discover prime`.
3. The diff of `insertPending`: the loop becomes one batch.
4. The after trace: one `D1 batch` span per feed, and the cron at about half the time.
