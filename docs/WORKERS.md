# Running on Workers: design, budgets and semantics

This game used to be a long-lived Node process: an in-process scheduler moved the opponent every eight seconds, an SSE stream pushed
state to the browser, SQLite was opened synchronously, and a 60-minute drain protected running games on shutdown. A Cloudflare
Worker has none of that: every request may land on a different isolate, nothing survives between requests, timers do not run
between them, CPU is capped at 10 ms per request on the free plan, and each invocation may issue only 50 database queries. This
page explains what replaced each of those pieces, what was measured, and what is still risky. Deployment steps are in
[DEPLOYMENT.md](DEPLOYMENT.md).

## What replaced what

| Container build | Workers build |
|---|---|
| Synchronous `node:sqlite` (`server/db.js`) | Async D1 interface everywhere (`env.DB.prepare().bind().first()/all()/run()`, `batch()`). Locally `local/database.js` wraps `node:sqlite` in the same interface, so tests run on real SQLite, never a mock |
| `MatchService` with a 200 ms `setInterval` tick | Pure functions of persisted state plus the clock: `advance()` in `server/matches.js` applies whatever has become due when a request touches the match |
| In-memory pending decisions and monotonic anchors | `pending_decisions` rows (a durable lease) and `started_at` on the match |
| SSE stream, heartbeat | The browser polls `GET /api/matches/:id` (1 s visible, 4 s hidden). `/events` answers 410 |
| Restart recovery that voided running matches | Abandonment voiding, applied lazily (below). No restarts exist |
| 60-minute graceful drain, `SHUTDOWN_GRACE_MS` | Nothing to drain: state is in the database after every request |
| In-memory rate limiter | Per-isolate limiter for cheap reads only; D1 quota rows (`reserve()`) for anything that spends money or writes state |
| Replay re-simulation at finalize | Per-append verification (below); independent replay verification still available offline and in tests |
| `generatePuzzle` per practice game | 300 verified puzzles in `migrations/0002_practice_pool.sql` plus a random symmetry transform per match |
| Cron / maintenance script | Lazy bounded sweep on light requests (`server/maintenance.js`) |
| `node:crypto` | Web Crypto (SHA-256, HMAC, Ed25519 verify); launch links are byte-compatible with the old format |

## The opponent's clock without a process

A race is two independent boards plus a wall clock. The opponent's schedule is a pure function of stored state: after its last
action at `jev.lastActionMs`, its next step is due at `lastActionMs + pacingMs`. Nothing needs to *run* at that instant.

* **Lazy application.** Any request that touches a match calls `advance()`, which applies, in time order, every due occurrence:
  timeout at the limit, the closing of the human's one-second tie bucket, and opponent steps. Each recorded event is stamped with
  its **scheduled** time (or the moment its decision would have been ready in-process: previous step plus the measured
  decision latency, if later), not with the arrival time of the request that recorded it. A player who returns after a minute
  therefore finds the opponent exactly where the schedule says it would be. `preprocessingMs`, `inferenceMs` and `pacingWaitMs`
  keep their meaning; `pacingWaitMs` is measured against the same stamped time.
* **Decisions are prepared ahead.** After a step is applied, the next decision (candidate generation, then the provider call) is
  prepared with `ctx.waitUntil` while the pacing delay elapses, exactly as the old scheduler prepared it while waiting. Only the
  provider call needs the network; on a local opponent nothing is prepared or stored.
* **Durable lease and quota reservation.** Preparing a decision starts with one `INSERT ... ON CONFLICT DO UPDATE ... WHERE`
  into `pending_decisions`. It succeeds for exactly one request per board revision; a crashed holder's lease expires after
  `2 x JEV_TIMEOUT_MS + 4 s`. Each provider attempt (retry included) first reserves one call from the daily and hourly D1
  quotas; a refused reservation yields an explicit `heuristic_fallback` with reason `provider_quota_limit`.
* **Compare-and-swap.** Every append is one atomic `batch`: the event row is inserted only if `matches.revision` still equals
  what the writer read, and the match row is updated under the same condition. A lost race re-reads and retries. A repeated
  request id is an idempotent no-op (`UNIQUE(match_id, request_id)`), as before. Human creates and moves keep their idempotency
  keys and `expectedHumanRevision`.
* **Ordering rule.** A human move is stamped with the time the server accepts it, so it must come after every opponent step
  that was already due. If steps are still owed (the per-request budget was spent, or a decision is in flight) the move is refused
  with `409 opponent_syncing` and the browser retries the same request id a moment later; it can never be applied twice.
* **Per-request step budget.** `stepBudget` (easy 6, normal 3, hard 1, jev 1; model-backed opponents at most 3) bounds the steps one
  request applies, so a request stays inside the CPU and query budgets. A returning player catches up over a few polls.
  Practical consequence: `PRACTICE_PACING_MS` below about one second is not supported on the harder profiles; the opponent cannot
  keep pace with a 250 ms clock at one step per request and moves are refused more often. The default of eight seconds is far
  inside the limits.

## Active-attempt voiding (documented semantics)

| Situation | Outcome |
|---|---|
| A ready reservation is older than 5 minutes, or its daily challenge day has ended | Voided (`expired_reservation`), no result counted; a ranked attempt stays consumed. Reservations older than 10 minutes are deleted |
| A running or settling attempt has had no request from its owner for `ABANDONED_AFTER_MS` (default 10 min) | Voided (`abandoned`) the next time the owner touches it or a sweep finds it. The old build voided running matches only at process restart; here there are no restarts, so silence is the equivalent signal |
| The 60-minute limit passes | `timeout` at exactly the limit, after every opponent step that was due before it |
| Event limit reached | Voided (`event_limit`), 429 |
| Provider fails, quota exhausted, request budget spent, or answers revealed | Downgraded to practice **before** the heuristic move; decisions are tagged `heuristic_fallback`, never `jev` |

Voided attempts are not wins, losses or draws and are excluded from completion-rate denominators, as before.

## Integrity: per-append verification instead of a finalize-time replay

Re-simulating a whole game costs far more than one Worker request may spend (hundreds of milliseconds for a `jev`-profile game), so
the verification moved to where each event is written:

1. `advanceState` validates every event against the authoritative state when it is appended (candidate membership, proofs,
   pacing, model and choice consistency), exactly as before.
2. Every append re-hashes the stored state and requires it to equal the `head_hash` recorded by the previous append, so a
   tampered or corrupted row is detected at the next write (`state_integrity_failed`, `verification_failed` operation).
3. Each event extends a SHA-256 hash chain (`chain_head`); its head is the result's `replay_hash`
   (`replayHashAlgorithm: "event-chain-sha256-v1"`).
4. Finalization re-checks the state hash, that the stored event count equals the sequence, and, for ranked matches, that no
   decision other than `jev` or `forced` is present. Otherwise no result row is written and nothing can rank.
5. The replay download is the stored events verbatim, so anyone can run the full independent `replayEvents()` verification
   (the test suite does, for finished races). Only verified server records with a real model call rank; nothing was added that
   writes a score.

Versions: `engine: "lazy-schedule-v1"` and (for practice) `puzzleSource: "pool-transform-v1"` are recorded in each match config so
cohorts from this scheduling model are never mixed with another. Rules (`sudoku-v1`), policy (`sudoku-policy-v1`), the model
prompt and the analytics schema are **unchanged**; candidate generation was optimized and is pinned byte for byte against the
original by `fixtures/candidates-golden.json` (`npm run golden:candidates` regenerates it from a reference build only).

Provider calls are quota-limited in D1 (`MAX_JEV_CALLS_PER_DAY`, `JEV_CALLS_PER_HOUR`, `MAX_JEV_REQUESTS_PER_MATCH`); the model
never receives the solution grid, the human board, history or result (tests inspect every request body).

## CPU: what was measured

`npm run bench:requests` runs each hot path through the real `handle()` (including the work it schedules with `waitUntil`),
subtracts time inside the database (a network round trip on D1, in-process here), and repeats it 30 times warm plus once cold in a
fresh process. It writes `reports/workers/request-cpu.json`. Warm-up code in `server/warmup.js` runs at module load (Workers'
startup phase, not billed to a request), which cut the first-request cost of `jev` candidate generation from about 16 ms to about 7 ms.

<!-- BENCH:START -->
Application CPU per invocation in milliseconds (limit 10). "Cold" is the first call in a fresh process after module load. D1 statements are the most one invocation issued (limit 50 queries).

| Path | Runs | Median | p95 | Max | Cold | D1 stmts | Within 10 ms (p95 / cold) |
|---|---:|---:|---:|---:|---:|---:|---|
| GET /api/me (new session) | 29 | 0.17 | 0.3 | 0.34 | 0.48 | 4 | yes / yes |
| GET / (worker-first document) | 29 | 0.8 | 1.08 | 1.23 | 1.94 | 0 | yes / yes |
| POST /api/matches (practice create, pool puzzle) | 29 | 0.56 | 1.61 | 1.67 | 2.27 | 14 | yes / yes |
| POST start (easy, model-backed) incl. first decision preparation | 29 | 1.16 | 2.05 | 2.09 | 3.64 | 18 | yes / yes |
| POST start (normal, model-backed) incl. first decision preparation | 29 | 1.52 | 2.24 | 2.29 | 4.4 | 18 | yes / yes |
| POST start (hard, model-backed) incl. first decision preparation | 29 | 2.64 | 3.36 | 3.58 | 4.82 | 18 | yes / yes |
| POST start (jev, model-backed) incl. first decision preparation | 29 | 3.37 | 4.06 | 5.19 | 6.29 | 18 | yes / yes |
| GET poll, nothing due (jev, model-backed) | 29 | 0.18 | 0.31 | 0.33 | 0.64 | 3 | yes / yes |
| model-backed opponent: GET poll applying one due step (easy) + next decision | 29 | 1.01 | 2.2 | 2.24 | 2.07 | 14 | yes / yes |
| model-backed opponent: GET poll applying one due step (normal) + next decision | 29 | 1.34 | 1.84 | 2.19 | 2.28 | 14 | yes / yes |
| model-backed opponent: GET poll applying one due step (hard) + next decision | 29 | 3.79 | 6.66 | 9.47 | 3.86 | 14 | yes / yes |
| model-backed opponent: GET poll applying one due step (jev) + next decision | 29 | 5.75 | 7.42 | 8.09 | 7.7 | 14 | yes / yes |
| model-backed opponent: GET poll catching up 3 due steps (easy, the per-request budget) | 29 | 3.22 | 5.22 | 5.67 | 4.07 | 29 | yes / yes |
| model-backed opponent: GET poll catching up 3 due steps (normal, the per-request budget) | 29 | 4.29 | 6.05 | 6.23 | 5.47 | 29 | yes / yes |
| model-backed opponent: GET poll catching up 1 due steps (hard, the per-request budget) | 29 | 1.56 | 2.27 | 2.4 | 2.13 | 7 | yes / yes |
| model-backed opponent: GET poll catching up 1 due steps (jev, the per-request budget) | 29 | 1.7 | 2.68 | 2.75 | 2.13 | 7 | yes / yes |
| local opponent: GET poll catching up 6 due steps (easy) | 29 | 3.83 | 5.68 | 9.99 | 4.98 | 15 | yes / yes |
| local opponent: GET poll catching up 3 due steps (normal) | 29 | 3.21 | 4.97 | 5.65 | 4.28 | 9 | yes / yes |
| local opponent: GET poll catching up 1 due steps (hard) | 29 | 2.86 | 4.29 | 4.53 | 4.63 | 5 | yes / yes |
| local opponent: GET poll catching up 1 due steps (jev) | 29 | 3.94 | 6.34 | 6.5 | 5.59 | 5 | yes / yes |
| local opponent: GET poll applying one due step (normal) | 29 | 1.37 | 3.65 | 4.44 | 2.87 | 4 | yes / yes |
| local opponent: GET poll applying one due step (jev) | 29 | 4.39 | 6.57 | 6.68 | 6.39 | 4 | yes / yes |
| POST human action (set digit), jev profile | 29 | 0.68 | 0.88 | 0.96 | 1.26 | 9 | yes / yes |
| POST forfeit -> finalize after a full opponent run (normal, ~60 events) | 14 | 1.07 | 1.25 | 1.25 | 1.22 | 16 | yes / yes |
| POST forfeit -> finalize after a full opponent run (jev, ~100 events) | 14 | 0.88 | 1.59 | 1.59 | 1.32 | 16 | yes / yes |
| GET /api/matches/:id/analytics (finished jev match, ~1 MB of evidence: refused with 413) | 14 | 0.25 | 0.29 | 0.29 | 0.41 | 4 | yes / yes |
| GET /api/matches/:id/analytics (finished normal match, full evidence under the size cap) | 29 | 4.96 | 5.95 | 6.39 | 4.49 | 6 | yes / yes |
| GET /api/matches/:id/analytics?evidence=omit (finished jev match, on-screen view) | 14 | 5.88 | 9.62 | 9.62 | 6.81 | 5 | yes / yes |
| GET /api/matches/:id/analytics?evidence=omit (finished normal match) | 29 | 2.71 | 3.2 | 3.37 | 3 | 5 | yes / yes |
| GET /api/matches/:id/replay (finished jev match) | 14 | 3.41 | 4.61 | 4.61 | 3.14 | 5 | yes / yes |
| POST telemetry batch (50 events) | 29 | 0.34 | 0.42 | 0.43 | 0.82 | 7 | yes / yes |
| GET /api/leaderboard (world, 50 entries) | 29 | 0.28 | 0.33 | 0.33 | 0.65 | 5 | yes / yes |
| GET /api/analytics/me (100 matches) | 29 | 0.32 | 20.64 | 20.69 | 1.4 | 5 | **no** / yes |
| GET /api/analytics/operator (500 results, uncached) | 14 | 10.62 | 37.79 | 37.79 | 3.8 | 16 | **no** / yes |
| GET /api/analytics/operator (cached, 5 min) | 29 | 0.19 | 0.29 | 0.32 | 0.58 | 3 | yes / yes |
| POST /api/discord/interactions (signed /jev sudoku) | 29 | 0.64 | 0.89 | 0.89 | 2.87 | 4 | yes / yes |
| lazy maintenance sweep (forced, 60 stale rows) | 29 | 0.03 | 0.04 | 0.05 | 0.96 | 11 | yes / yes |

Measured 2026-09-30 on Node v24.18.0, win32 x64 AMD Ryzen 9 7950X 16-Core Processor. Methodology and limits are in the report's `method` and `limits` fields.
<!-- BENCH:END -->

What was done about the expensive operations:

* **Candidate generation** (the `hard` and `jev` profiles) was 15 to 30 ms per step. The lookahead now maintains candidate masks
  incrementally and checks contradictions in one unit pass; the output is byte-identical (golden test), and the cost fell to 1 to 5 ms.
  A small memo avoids computing the same board twice in one isolate.
* **Puzzle generation** (5 to 10 ms warm with a heavy tail) is not done at request time: practice puzzles come from a verified pool
  with a random transform.
* **Finalize** no longer re-simulates the game (see integrity above) and no longer builds a full analytics report: the stored result is a
  state-derived summary of about 1 KB plus provider usage.
* **Replay download** concatenates stored event strings instead of parsing about a megabyte of candidate evidence.
* **Analytics** replays the events in trusted mode (no candidate re-derivation) and, for on-screen use, strips the per-decision
  evidence in SQL (`?evidence=omit`); the full-evidence form is refused with `413 evidence_too_large` above 350 KB (use the replay).
* **Operator report** reads compact summaries and SQL aggregates, is capped at 1,000 result rows, and is cached for five minutes.
* **Personal export** is paged (about 400 KB of events per page).

What is still risky or over budget, honestly:

* Numbers are from Node/V8 on a developer machine, not the Workers runtime. Cold `jev`-profile steps are within 2 to 3 ms of the
  limit even with warm-up; a slow isolate could exceed 10 ms on that path. If Cloudflare reports `exceeded CPU limit` for
  `GET /api/matches/:id`, lower `stepBudget.jev` or serve the `jev` profile only to signed-in players.
* The **uncached operator report** (about 10 ms median for 500 stored results, rising with history up to the 1,000-row cap) is over
  the limit; it is admin-initiated and cached for five minutes, but the request that rebuilds the cache can exceed 10 ms and fail with
  `exceeded CPU limit`, in which case the next attempt hits the same wall until the window has fewer results (lower `days`). The
  **on-screen analytics of a long `jev` game** (about 6 ms median, 9.6 ms p95) is near the limit.
* **Unexplained tails.** In the benchmark, `GET /api/analytics/me` (median 0.3 ms) and the two above showed isolated 20 to 40 ms
  runs that I did not isolate (garbage collection or scheduling on a busy machine is the likely cause, not code). Nothing in those
  paths is unbounded (they read at most 200 small summaries), but the tail is unproven on Workers.
* **First requests on a cold isolate.** `hard` and `jev` opponent steps measure 4 to 8 ms cold after warm-up (16 ms before it). A
  slower real isolate could push the `jev` profile over 10 ms; the mitigation is the per-request step budget of 1 and the option in the first bullet.
* `performance.now()` does not advance during pure computation on Workers, so `preprocessingMs` in production analytics reads about 0.
  Inference latency (network) is measured correctly.
* Provider latency, D1 round trips and waits are wall time on Workers and not counted here; the model call is a fake that answers instantly.

## Database queries per invocation

Workers Free allows 50 queries per invocation. `tests/budget.test.js` counts every statement (a batch counts once per statement, the
conservative reading) and fails above 45 for: catch-up polls on every profile with and without a model, create, start, a move, finalize,
and a request that also runs the sweep. Typical counts are 3 for an idle poll, 14 for a poll that applies a step and prepares the next,
and 29 for the largest catch-up. Reads that used to grow with history use SQL aggregates and stored summaries.

## Data model changes

`migrations/0001.sql` is the container-era schema plus: `matches.revision/head_hash/chain_head/decision_json/last_seen_at`, the partial
unique indexes that make "one active match per session/account" atomic, `match_events.chain_hash`, `pending_decisions`, `puzzle_pool`,
`quotas`, `meta`, `report_cache`, and `results.summary_json` in place of a cached full report (the full report is rebuilt from events
on demand, so retention and consent withdrawal can never leave a stale copy). Ranked puzzles remain in `challenges` and are published
out of band because they must stay secret until played.
