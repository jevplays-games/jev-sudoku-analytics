# Testing and release evidence

## Executed checks (Cloudflare build)

Regenerated for the Workers build; the numbers are written by the commands themselves.

| Check | Command | Evidence |
|---|---|---|
| Node unit/integration tests over real SQLite through the D1-compatible shim | `npm test` | `reports/workers/node-tests.tap` |
| Request CPU and D1-query benchmark of the hot paths | `npm run bench:requests` | `reports/workers/request-cpu.json` |
| Chromium browser scenarios (native navigation, real Worker through the local adapter) | `npm run test:browser` | `reports/workers/browser-results.json`, screenshots |
| Isolated CLI/SQLite maintenance scenarios | `npm run test:maintenance` | `reports/workers/maintenance-results.json` |
| Offline selector benchmark | `npm run benchmark -- --puzzles 2` | `reports/benchmark.json` (unchanged, see below) |

These are different granularities; do not add scenario counts to the Node test count. `reports/` files outside `reports/workers/` (including `release-summary.json`, `node-tests.tap`, the screenshots referenced by the README, and the container-era run logs) are the **original container-era evidence** and are kept as history. They describe the previous Node/Docker build and are not evidence for the Workers build. Never edit generated outputs by hand: rerun the command.

## Node coverage by behavior

- **Rules and shared code** (`rules`, `analytics`): conventional units, immutable givens, wrong-but-locally-legal guesses, replacement, clear/undo, solution uniqueness, independent board arrays, completion, replay reconstruction, tamper rejection, timing buckets, first/second finish, timeouts, deduction legality, explicit backtracking; action accounting, exact distributions/entropy, missing denominators, cost completeness, trust separation, redaction, streaks, void exclusion, CSV injection protection.
- **Candidate generation is pinned** (`candidates-golden`): hashes of the full candidate set, features and lookahead previews along 32 seeded walks (four profiles, canonical and random selectors, including contradictions and backtracks) must equal the values recorded from the original, unoptimized implementation. CPU work never changes behavior.
- **Provider adapter** (`jev`): valid selection, malformed/unknown fields, wrong model and candidate keys, probability validation against the provider's 0.01 grain, timeout, retry, authorization failure, long Retry-After, forced actions, absent credentials, quota refusal before any network call, one reservation per attempt, and no hidden state in the request. No paid API calls are made by `npm test`.
- **Security** (`security`, `activity`): CSRF, HMAC launch tampering/expiry/audience/subject and byte-compatibility with the container-era format, real generated Ed25519 signatures verified with Web Crypto, raw-byte binding, one-use redemption (a single conditional UPDATE), signed interaction replay rejection, OAuth state binding/expiry/one-use, session rotation, guest-match adoption, token non-persistence, bearer-session Activity mode, frame policy.
- **Match lifecycle** (`service`): withholding clues, ownership, revisions, idempotency, forbidden score/time fields; **lazy scheduling** (events stamped with scheduled times, per-request step budget, catch-up, human moves ordered after due opponent steps, timeouts, abandonment voiding, sweep); **durable lease** (one provider call per board, expired lease retaken); **compare-and-swap** (stale writer loses, duplicate request id idempotent, tampered state refused); ranked redaction; hidden state never sent to the model; explicit fallback downgrade and quota fallback; end-to-end ranked race with a real (fake-provider) model call, independent full replay verification, leaderboard entry and one-attempt tombstones; finalization refusing a non-model ranked decision; leaderboards, pagination, operator aggregates, retention purge and result retry.
- **HTTP API** (`api`): headers, static allowlist, HSTS/Secure cookies, fail-closed misconfiguration, create/start/act/analytics/replay, ownership, polling replaces SSE (`410` on the old route), retry-safe `opponent_syncing`, 422 rule violations, telemetry consent/allowlist/batching/purge, personal reports, paged export and deletion, rate limits from D1, operator access and caching, body limits.
- **Runtime** (`runtime`): no Node built-ins, `process`, `Buffer` or timer loops in `server/` or `public/shared/`; `wrangler.jsonc` matches the free-plan constraints (no crons, no custom CPU limit, DB placeholder, routes, `run_worker_first`); D1 shim semantics (null misses, `RETURNING`, change counts, atomic batches); migrations applied once and refusal of a container-era database file; quota reservations; puzzle pool validity and transform invariants (unique solution, clue count, consistency); sweep gating; local adapter over real HTTP including path-traversal guards for POSIX and Windows separators.
- **Budgets** (`budget`): counts database statements per invocation for catch-up polls on every profile with and without a model, create, start, a move, finalize and a sweep-bearing request, and fails above 45 (Workers Free allows 50); provider usage patched into stored results in one batch.

An optional `npm run test:coverage` command is supplied; no coverage percentage is claimed.

## CPU benchmark

`npm run bench:requests` measures application CPU per Worker invocation (including `waitUntil` work), with time inside the database subtracted, warm (median/p95/max over 30 runs) and cold (first call in a fresh process), and reports the D1 statements issued. The full table and its interpretation are in [WORKERS.md](WORKERS.md). It is a Node/V8 measurement on a developer machine: it cannot prove behavior on the Workers runtime, and the provider is a fake that answers instantly. Single spikes of tens of milliseconds in otherwise sub-millisecond paths are scheduler/GC noise in that environment; medians and cold numbers are the informative columns.

## Browser scenarios

The smoke test launches real headless Chromium against a temporary local server (the Worker behind the Node adapter, temporary SQLite), checks the actual HTML/CSS/ES-module UI on desktop 1440px and mobile 390px, enters values through keyboard events, and uses a test-only exact solver to supply digits (never passed to JEV). Nine scenarios: both 81-cell boards, honest local-opponent labeling, pencil marks, entry/undo acknowledgements, opt-in telemetry preference, analytics chart/heatmap, JSON download, full puzzle completion with a verified server result, replay scrubbing, leaderboard empty/unauthorized states, reload recovery, mobile overflow/rules access and uncaught JavaScript errors. The game polls (there is no event stream), so no polling simulation is used; the accelerated practice pacing is 2 seconds.

```bash
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
npm run test:browser
```

The script tries ordinary navigation first and falls back to an in-memory bridge only where the environment blocks it; inspect `browserTransport` in the result. It does not cover Cloudflare's edge, real CSP enforcement on the deployed origin, or HTTPS; do that check in staging.

## Maintenance scenarios

```bash
npm run test:maintenance
```

Isolated temporary database: unique daily publication and non-overwrite, wrangler-ready SQL emission, JSON/CSV/operator CLI exports, lazy purge of expired optional telemetry with core game and result retained, backup reopening/integrity/foreign keys, refusal to overwrite a backup. It does not exercise D1, `wrangler`, remote exports or restoration.

## Benchmark protocol (policy)

```bash
npm run benchmark -- --puzzles 2 --split smoke --out reports/benchmark.json
```

Two independently seeded synthetic puzzle families, four technique profiles and three selectors (canonical first, deterministic greedy, seeded random), each receiving the same bounded candidate generation. Candidate generation is byte-identical to the version that produced the shipped `reports/benchmark.json` (pinned by the golden test), so that report remains valid for the policy; it says nothing about the scheduling model. `liveJevUsed=false`: **it measures local selection baselines, not TypeSafe JEV quality.** For an explicit paid run add `--live --selectors jev` (requires a key; it can generate many requests and is not constrained by the web-match request budget). Use separate `development` and `holdout` seed namespaces and archive configs and transcripts.

## Not tested

The deployed Cloudflare runtime (real CPU time, cold starts, D1 latency and limits), live Discord and TypeSafe traffic, Wrangler deployment and DNS, edge rate limiting, load beyond the benchmark, assistive-technology audits and adversarial penetration tests. Passing finite tests are evidence for the tested behaviors, not production certification or an assertion of unaided-human anti-cheat.
